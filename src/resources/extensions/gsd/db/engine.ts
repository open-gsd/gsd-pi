// Project/App: gsd-pi
// File Purpose: GSD engine — connection ownership, lifecycle, schema/migrations,
// and transaction primitives for the single-writer layer. The shared handle
// (currentDb) lives here; domain writers, allowlisted coordination/runtime
// writers, schema/migration helpers, and the Query Module (db/queries.ts) read
// it through getDb()/getDbOrNull().
//
// This file legitimately holds DDL and BEGIN/COMMIT control, so it is
// allowlisted in tests/single-writer-invariant.test.ts alongside the explicit
// writer layer.
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { syncDirectoryEntry } from "@gsd/native/directory-sync";

import { GSDError, GSD_STALE_STATE } from "../errors.js";
import { getDatabaseReplacementPaths } from "../database-replacement-paths.js";
import {
  assertDatabaseMaintenanceFenceAllowsWrite,
  claimProjectionMaintenance,
  databaseMaintenanceIntentPath,
  withDatabaseMaintenanceOwner,
} from "../database-maintenance-fence.js";
import type { GsdWorkspace, MilestoneScope } from "../workspace.js";
import { logError, logWarning } from "../workflow-logger.js";
import { createDbAdapter, type DbAdapter } from "../db-adapter.js";
import { createBaseSchemaObjects } from "../db-base-schema.js";
import { hasRequiredSchemaObjects } from "../db-required-schema.js";
import { createCoordinationTablesV24 } from "../db-coordination-schema.js";
import { createDbConnectionCache, type DbConnectionCacheEntry } from "../db-connection-cache.js";
import { backupDatabaseBeforeMigration, isMigrationBackupError } from "../db-migration-backup.js";
import {
  applyMigrationV2Artifacts,
  applyMigrationV3Memories,
  applyMigrationV4DecisionMadeBy,
  applyMigrationV5HierarchyTables,
  applyMigrationV6SliceSummaries,
  applyMigrationV7Dependencies,
  applyMigrationV8PlanningFields,
  applyMigrationV9Ordering,
  applyMigrationV10ReplanTrigger,
  applyMigrationV11TaskPlanning,
  applyMigrationV12QualityGates,
  applyMigrationV13HotPathIndexes,
  applyMigrationV14SliceDependencies,
  applyMigrationV15AuditTables,
  applyMigrationV16EscalationSource,
  applyMigrationV17TaskEscalation,
  applyMigrationV18MemorySources,
  applyMigrationV19MemoryFts,
  applyMigrationV20MemoryRelations,
  applyMigrationV21StructuredMemories,
  applyMigrationV22QualityGateRepair,
  applyMigrationV23MilestoneQueue,
  applyMigrationV26MilestoneCommitAttributions,
  applyMigrationV27ArtifactHash,
  applyMigrationV28MemoryLastHitAt,
  applyMigrationV29RepositoryTargets,
  applyMigrationV30ReworkBriefs,
  applyMigrationV31CanonicalFoundation,
  applyMigrationV32LifecycleFoundation,
  applyMigrationV33ConversationFoundation,
  applyMigrationV34RecoveryEvidenceFoundation,
  applyMigrationV35ProjectionImportKernelCloseoutFoundation,
  applyMigrationV36AttemptRecovery,
  applyMigrationV37TaskCancellation,
  applyMigrationV38TaskVerificationRecovery,
  applyMigrationV39TaskRecoveryCurrentHead,
  applyMigrationV40SliceCancellation,
  applyMigrationV41SliceCompletion,
  applyMigrationV42MilestoneValidation,
  applyMigrationV43MilestoneCompletion,
  applyMigrationV44MilestoneReopen,
  applyMigrationV45AuthorityRecovery,
  applyMigrationV47SameLeaseAttemptSettlement,
  applyMigrationV48TaskToolRequirements,
  applyMigrationV49MilestoneVerdictScope,
  applyMigrationV50BlockerAcceptedCloseout,
} from "../db-migration-steps.js";
import {
  createCanonicalFoundationSchemaV31,
  ensureCanonicalOutboxInvariantsV31,
  hasCanonicalOutboxInvariantsV31,
} from "../db-canonical-foundation-schema.js";
import { createConversationFoundationSchemaV33 } from "../db-conversation-foundation-schema.js";
import { rebuildWorkflowItemLifecyclesForBlockerAccepted } from "../db-blocker-accepted-closeout-schema.js";
import { createLifecycleFoundationSchemaV32 } from "../db-lifecycle-foundation-schema.js";
import { createProjectionImportKernelCloseoutFoundationSchemaV35 } from "../db-projection-import-kernel-closeout-foundation-schema.js";
import { createRecoveryEvidenceFoundationSchemaV34 } from "../db-recovery-evidence-foundation-schema.js";
import {
  invalidateMemoriesFtsRebuildMarker,
  inspectMemoriesFtsStartupState,
  isMemoriesFtsAvailableSchema,
  rebuildMemoriesFtsSchemaOnce,
  tryCreateMemoriesFtsSchema,
} from "../db-memory-fts-schema.js";
import { createDbOpenState, type DbOpenPhase } from "../db-open-state.js";
import { createRuntimeKvTableV25, hasRuntimeKvSchemaV25 } from "../db-runtime-kv-schema.js";
import { getCurrentSchemaVersion, recordSchemaVersion } from "../db-schema-metadata.js";
import { createDbTransactionRunner } from "../db-transaction.js";
import {
  ensureVerificationEvidenceDedupIndex,
  hasVerificationEvidenceDedupIndex,
} from "../db-verification-evidence-schema.js";
import {
  captureSqliteOpenIdentity,
  correlateSqliteOpenIdentity,
  openSqliteReadOnly,
  releaseSqliteOpenIdentityCapture,
  type SqliteFileIdentity,
} from "../sqlite-readonly.js";
import { processStartIdentity } from "../process-start-identity.js";
import { isSqliteBusyError } from "../sqlite-errors.js";
import {
  createSqliteProviderLoader,
  suppressSqliteWarning,
  type DbProviderName,
} from "../db-provider.js";

export { getDatabaseReplacementPaths };
export type { DatabaseReplacementPaths } from "../database-replacement-paths.js";

let _gsdRequire: ReturnType<typeof createRequire> | null | undefined;

function getGsdRequire(): ReturnType<typeof createRequire> | null {
  if (_gsdRequire !== undefined) return _gsdRequire;
  try {
    // Next.js may emit this module into a CommonJS chunk. Avoid ESM-only module
    // metadata syntax here; it is a hard parse error there.
    const packageRoot = process.env.GSD_WEB_PACKAGE_ROOT || process.env.GSD_PKG_ROOT || process.cwd();
    _gsdRequire = createRequire(resolve(packageRoot, "package.json"));
  } catch {
    _gsdRequire = null;
  }
  return _gsdRequire;
}

type ProviderName = DbProviderName;
const providerLoader = createSqliteProviderLoader({
  tryRequireNodeSqlite: () => {
    const req = getGsdRequire();
    if (!req) throw new Error("unavailable");
    return req("node:sqlite");
  },
  suppressSqliteWarning,
  nodeVersion: process.versions.node,
  writeStderr: (message: string) => process.stderr.write(message),
});
export const SCHEMA_VERSION = 50;

/**
 * PRAGMA application_id stamped on every gsd.db at V46 so binaries and
 * external tools can cheaply identify DB-authored GSD state. Derivation:
 * the ASCII bytes of "GSDB" interpreted as a big-endian 32-bit unsigned
 * integer (0x47 'G' << 24 | 0x53 'S' << 16 | 0x44 'D' << 8 | 0x42 'B').
 */
export const GSD_APPLICATION_ID = 0x47534442;

/**
 * Typed refuse-newer error. The engine throws this when a database records a
 * schema version newer than this binary supports; read/write seams must
 * distinguish it from generic open failures and surface the exact message
 * instead of degrading to empty state (T003 spike: silent divergence).
 */
export class SchemaTooNewError extends Error {
  override readonly name = "GSDSchemaTooNewError";
  readonly currentVersion: number;
  readonly supportedVersion: number;

  constructor(currentVersion: number, supportedVersion: number) {
    super(
      `gsd.db schema is v${currentVersion}, newer than the v${supportedVersion} this gsd-pi supports. ` +
      `Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.`,
    );
    this.currentVersion = currentVersion;
    this.supportedVersion = supportedVersion;
  }
}

export function isSchemaTooNewError(err: unknown): err is SchemaTooNewError {
  // The name check keeps the guard reliable when the error crosses a module
  // instance boundary (e.g. jiti-loaded extension vs. directly imported).
  return err instanceof SchemaTooNewError
    || (err instanceof Error && err.name === "GSDSchemaTooNewError");
}

interface StartupRepairAssessment {
  readonly required: boolean;
  readonly forceMemoriesFtsRebuild: boolean;
}

function assessStartupRepair(db: DbAdapter): StartupRepairAssessment {
  _startupSchemaDetectionForTest?.();
  const schemaMetadata = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_version'
  `).get();
  const fts = inspectMemoriesFtsStartupState(db);
  const required = schemaMetadata === undefined
    || getCurrentSchemaVersion(db) !== SCHEMA_VERSION
    || !hasCanonicalOutboxInvariantsV31(db)
    || !hasVerificationEvidenceDedupIndex(db)
    || !hasRuntimeKvSchemaV25(db)
    || !hasRequiredSchemaObjects(db)
    || (fts.supported && (!fts.schemaComplete || !fts.rebuildMarked));
  return {
    required,
    forceMemoriesFtsRebuild: fts.supported && (!fts.schemaComplete || !fts.rebuildMarked),
  };
}

interface DatabaseMaintenanceCleanupState {
  claim: DatabaseMaintenanceClaim | undefined;
  projectionRelease: (() => void) | undefined;
}

function acquireStartupMaintenance(
  db: DbAdapter,
  databasePath: string,
): DatabaseMaintenanceCleanupState {
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("PRAGMA locking_mode=EXCLUSIVE").get();
  let transactionOpen = false;
  let exclusiveOwnershipAcquired = false;
  const maintenance: DatabaseMaintenanceCleanupState = {
    claim: undefined,
    projectionRelease: undefined,
  };
  try {
    db.exec("BEGIN EXCLUSIVE");
    transactionOpen = true;
    exclusiveOwnershipAcquired = true;
    assertDatabaseReplacementFenceAllowsPath(databasePath);
    assertDatabaseMaintenanceFenceAllowsWrite(databasePath);
    claimDatabaseMaintenance(databasePath, maintenance);
    db.exec("COMMIT");
    transactionOpen = false;
    return maintenance;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* retain lock/fence failure */ }
    }
    const cleanup: StartupCleanupState = {
      adapter: db,
      claim: maintenance.claim,
      projectionRelease: maintenance.projectionRelease,
      exclusiveOwnershipHeld: exclusiveOwnershipAcquired,
      adapterClosed: false,
    };
    try {
      cleanupStartupOwnership(cleanup);
    } catch (cleanupError) {
      quarantineStartupCleanup(cleanup);
      logWarning("db", `startup claim cleanup failed: ${(cleanupError as Error).message}`);
    }
    throw error;
  }
}

function releaseStartupExclusiveOwnership(db: DbAdapter): void {
  _startupExclusiveReleaseForTest?.();
  const journalMode = db.prepare("PRAGMA journal_mode=DELETE").get()?.["journal_mode"];
  if (journalMode !== "delete") {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Failed to leave startup journal mode: ${String(journalMode)}`);
  }
  const lockingMode = db.prepare("PRAGMA locking_mode=NORMAL").get()?.["locking_mode"];
  if (lockingMode !== "normal") {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Failed to release startup locking mode: ${String(lockingMode)}`);
  }
  db.prepare("SELECT 1 AS release_startup_lock").get();
}

function configureSchemaConnection(db: DbAdapter, fileBacked: boolean, dbPath: string | null): void {
  const conservativeFilePragmas = fileBacked && _isLikelyWslDrvFsPathForTest(dbPath);
  if (fileBacked) db.exec("PRAGMA busy_timeout = 5000");
  if (fileBacked) db.exec(conservativeFilePragmas ? "PRAGMA journal_mode=DELETE" : "PRAGMA journal_mode=WAL");
  if (fileBacked) db.exec(conservativeFilePragmas ? "PRAGMA synchronous = FULL" : "PRAGMA synchronous = NORMAL");
  if (fileBacked) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (fileBacked) db.exec("PRAGMA cache_size = -8000");
  if (fileBacked && !conservativeFilePragmas && process.platform !== "darwin") db.exec("PRAGMA mmap_size = 67108864");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");
}

function databaseHasLegacyData(db: DbAdapter): boolean {
  return ["milestones", "decisions", "memories"].some((table) => {
    const tableExists = db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table)?.["present"];
    if (!tableExists) return false;
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0) > 0;
  });
}

function prepareStartupMigrationBackup(db: DbAdapter, dbPath: string): void {
  const metadata = db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_version'
  `).get();
  if (metadata?.["present"]) {
    const currentVersion = getCurrentSchemaVersion(db);
    if (currentVersion > 0 && currentVersion < SCHEMA_VERSION) {
      backupDatabaseBeforeMigration(db, dbPath, currentVersion, { existsSync, copyFileSync, logWarning });
    } else if (currentVersion === 0 && databaseHasLegacyData(db)) {
      backupDatabaseBeforeMigration(db, dbPath, 1, {
        existsSync,
        copyFileSync,
        logWarning,
        allowMissingSchemaVersion: true,
      });
    }
    return;
  }

  if (databaseHasLegacyData(db)) {
    backupDatabaseBeforeMigration(db, dbPath, 1, {
      existsSync,
      copyFileSync,
      logWarning,
      allowMissingSchemaVersion: true,
    });
  }
}

function configureOpenConnection(db: DbAdapter, path: string): void {
  const conservativeFilePragmas = _isLikelyWslDrvFsPathForTest(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(conservativeFilePragmas ? "PRAGMA synchronous = FULL" : "PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -8000");
  if (!conservativeFilePragmas && process.platform !== "darwin") db.exec("PRAGMA mmap_size = 67108864");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");
}

function restoreRuntimeJournalMode(db: DbAdapter, path: string): void {
  if (_isLikelyWslDrvFsPathForTest(path)) return;
  const journalMode = db.prepare("PRAGMA journal_mode=WAL").get()?.["journal_mode"];
  if (journalMode !== "wal") {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Failed to restore WAL journal mode: ${String(journalMode)}`);
  }
}

function configureMutationFreeConnection(db: DbAdapter): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
}

function initSchema(
  db: DbAdapter,
  fileBacked: boolean,
  dbPath: string | null,
  startupTransactionOpen = false,
  migrationBackupPrepared = false,
  forceMemoriesFtsRebuild = false,
): void {
  if (!startupTransactionOpen) configureSchemaConnection(db, fileBacked, dbPath);

  db.exec(startupTransactionOpen ? "SAVEPOINT schema_initialization" : "BEGIN");
  try {
    createBaseSchemaObjects(db, {
      tryCreateMemoriesFts,
      ensureVerificationEvidenceDedupIndex,
    });
    if (forceMemoriesFtsRebuild) invalidateMemoriesFtsRebuildMarker(db);

    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && (existing["cnt"] as number) === 0) {
      // An empty schema_version table usually means a fresh install, but it can
      // also be a legacy/truncated DB that already holds user data. Stamping
      // that DB SCHEMA_VERSION without running migrations would mis-mark it as
      // fully migrated and break at first query. Probe before stamping.
      const hasData = databaseHasLegacyData(db);
      if (hasData) {
        // Legacy DB with data but no version row: record the baseline so
        // migrateSchema runs the full chain instead of stamping the current version.
        recordSchemaVersion(db, 1);
      } else {
        createCoordinationTablesV24(db);
        createRuntimeKvTableV25(db);
        createCanonicalFoundationSchemaV31(db);
        createLifecycleFoundationSchemaV32(db);
        createConversationFoundationSchemaV33(db);
        createRecoveryEvidenceFoundationSchemaV34(db);
        createProjectionImportKernelCloseoutFoundationSchemaV35(db);
        applyMigrationV36AttemptRecovery(db);
        applyMigrationV37TaskCancellation(db);
        applyMigrationV38TaskVerificationRecovery(db);
        applyMigrationV39TaskRecoveryCurrentHead(db);
        applyMigrationV40SliceCancellation(db);
        applyMigrationV41SliceCompletion(db);
        applyMigrationV42MilestoneValidation(db);
        applyMigrationV43MilestoneCompletion(db);
        applyMigrationV44MilestoneReopen(db);
        applyMigrationV45AuthorityRecovery(db);
        applyMigrationV47SameLeaseAttemptSettlement(db);
        applyMigrationV48TaskToolRequirements(db);
        applyMigrationV49MilestoneVerdictScope(db);
        applyMigrationV50BlockerAcceptedCloseout(db);

        // Fresh install — all tables are created above with the full current schema,
        // so it is safe to create all migration-specific indexes here.  For existing
        // databases these indexes are created inside the individual migration guards
        // in migrateSchema() after the corresponding columns have been added.
        db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_scope ON memory_sources(scope)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_rework_briefs_task ON rework_briefs(milestone_id, slice_id, task_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_rework_findings_status ON rework_brief_findings(brief_id, severity, status)");

        recordSchemaVersion(db, SCHEMA_VERSION);
        // Fresh DBs get the same V46 cutover stamps as migrated DBs so new
        // and upgraded databases are indistinguishable.
        stampStateCutoverPragmas(db, SCHEMA_VERSION);
      }
    }

    db.exec(startupTransactionOpen ? "RELEASE SAVEPOINT schema_initialization" : "COMMIT");
  } catch (err) {
    db.exec(startupTransactionOpen
      ? "ROLLBACK TO SAVEPOINT schema_initialization; RELEASE SAVEPOINT schema_initialization"
      : "ROLLBACK");
    throw err;
  }

  migrateSchema(db, dbPath, startupTransactionOpen, migrationBackupPrepared);
  ensureCanonicalOutboxInvariantsV31(db);
  rebuildMemoriesFtsSchemaOnce(db, {
    force: forceMemoriesFtsRebuild,
    onRebuildFailed: (message) => logWarning("db", message),
    transactionOpen: startupTransactionOpen,
  });
}

export function _isLikelyWslDrvFsPathForTest(dbPath: string | null): boolean {
  if (!dbPath || process.platform !== "linux") return false;
  const drvFsPathPattern = /^\/mnt\/[a-z](?:\/|$)/i;
  if (drvFsPathPattern.test(dbPath)) return true;
  try {
    return drvFsPathPattern.test(realpathSync(dbPath));
  } catch {
    return false;
  }
}

/**
 * Create the FTS5 virtual table for memories plus the triggers that keep it
 * in sync with the base table. FTS5 may be unavailable on stripped-down
 * SQLite builds — callers should treat failure as non-fatal and fall back
 * to LIKE-based scans in `memory-store.queryMemoriesRanked`.
 */
export function tryCreateMemoriesFts(db: DbAdapter): boolean {
  return tryCreateMemoriesFtsSchema(db, {
    onUnavailable: (message) => logWarning("db", message),
  });
}

export function isMemoriesFtsAvailable(db: DbAdapter): boolean {
  return isMemoriesFtsAvailableSchema(db);
}

function backfillMemoriesFts(db: DbAdapter): void {
  db.exec(`INSERT INTO memories_fts(rowid, content) SELECT seq, content FROM memories`);
}

function copyQualityGateRowsToRepairedTable(db: DbAdapter): void {
  db.exec(`
    INSERT OR IGNORE INTO quality_gates_new
      (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
    SELECT milestone_id, slice_id, gate_id, scope, COALESCE(task_id, ''), status, verdict, rationale, findings, evaluated_at
    FROM quality_gates
  `);
}

let _migrationFaultForTest = false;
/** Test-only: force migrateSchema to throw after applying its steps but before COMMIT. */
export function _setMigrationFaultForTest(v: boolean): void { _migrationFaultForTest = v; }

/**
 * Stamp the state-DB cutover PRAGMAs so binaries and external tools can
 * detect DB-authored GSD state cheaply (PRAGMA application_id/user_version
 * are readable without parsing schema_version). No table changes.
 */
function stampStateCutoverPragmas(db: DbAdapter, version: number): void {
  db.exec(`PRAGMA application_id = ${GSD_APPLICATION_ID}`);
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * V46 — state-DB cutover stamp. Adds/alters NO tables; it only stamps
 * application_id + user_version and records schema version 46.
 */
function applyMigrationV46StateCutoverStamp(db: DbAdapter): void {
  stampStateCutoverPragmas(db, 46);
  recordSchemaVersion(db, 46);
}

function migrateSchema(
  db: DbAdapter,
  dbPath: string | null,
  startupTransactionOpen = false,
  migrationBackupPrepared = false,
): void {
  const currentVersion = getCurrentSchemaVersion(db);
  if (currentVersion > SCHEMA_VERSION) {
    throw new SchemaTooNewError(currentVersion, SCHEMA_VERSION);
  }
  if (currentVersion === SCHEMA_VERSION) return;

  if (!migrationBackupPrepared) {
    backupDatabaseBeforeMigration(db, dbPath, currentVersion, {
      existsSync,
      copyFileSync,
      logWarning,
    });
  }

  // V50 (#2202) is hoisted above the migration transaction: relaxing the
  // lifecycle CHECK requires SQLite's foreign-keys-off table rebuild, and
  // PRAGMA foreign_keys cannot change inside a transaction. Fresh installs
  // skip the rebuild (their V32 DDL already carries the extended CHECK). The
  // trigger/index layer runs in the normal V50 step below.
  if (currentVersion < 50 && !startupTransactionOpen) {
    rebuildWorkflowItemLifecyclesForBlockerAccepted(db);
  }

  db.exec(startupTransactionOpen ? "SAVEPOINT schema_migration" : "BEGIN");
  try {
    if (currentVersion < 2) {
      applyMigrationV2Artifacts(db);
      recordSchemaVersion(db, 2);
    }

    if (currentVersion < 3) {
      applyMigrationV3Memories(db);
      recordSchemaVersion(db, 3);
    }

    if (currentVersion < 4) {
      applyMigrationV4DecisionMadeBy(db);
      recordSchemaVersion(db, 4);
    }

    if (currentVersion < 5) {
      applyMigrationV5HierarchyTables(db);
      recordSchemaVersion(db, 5);
    }

    if (currentVersion < 6) {
      applyMigrationV6SliceSummaries(db);
      recordSchemaVersion(db, 6);
    }

    if (currentVersion < 7) {
      applyMigrationV7Dependencies(db);
      recordSchemaVersion(db, 7);
    }

    if (currentVersion < 8) {
      applyMigrationV8PlanningFields(db);
      recordSchemaVersion(db, 8);
    }

    if (currentVersion < 9) {
      applyMigrationV9Ordering(db);
      recordSchemaVersion(db, 9);
    }

    if (currentVersion < 10) {
      applyMigrationV10ReplanTrigger(db);
      recordSchemaVersion(db, 10);
    }

    if (currentVersion < 11) {
      applyMigrationV11TaskPlanning(db);
      recordSchemaVersion(db, 11);
    }

    if (currentVersion < 12) {
      // NOTE: The original DDL used COALESCE(task_id, '') in the PRIMARY KEY
      // expression, which is invalid SQLite syntax and causes startup errors on
      // DBs that migrate through v12. The corrected DDL uses
      // task_id TEXT NOT NULL DEFAULT '' with a plain column list PK. DBs that
      // were created with the broken DDL are repaired by the v22 migration below.
      applyMigrationV12QualityGates(db);
      recordSchemaVersion(db, 12);
    }

    if (currentVersion < 13) {
      applyMigrationV13HotPathIndexes(db, ensureVerificationEvidenceDedupIndex);
      recordSchemaVersion(db, 13);
    }

    if (currentVersion < 14) {
      applyMigrationV14SliceDependencies(db);
      recordSchemaVersion(db, 14);
    }

    if (currentVersion < 15) {
      applyMigrationV15AuditTables(db);
      recordSchemaVersion(db, 15);
    }

    if (currentVersion < 16) {
      applyMigrationV16EscalationSource(db);
      recordSchemaVersion(db, 16);
    }

    if (currentVersion < 17) {
      applyMigrationV17TaskEscalation(db);
      recordSchemaVersion(db, 17);
    }

    if (currentVersion < 18) {
      applyMigrationV18MemorySources(db);
      recordSchemaVersion(db, 18);
    }

    if (currentVersion < 19) {
      applyMigrationV19MemoryFts(db, {
        tryCreateMemoriesFts,
        isMemoriesFtsAvailable,
        backfillMemoriesFts,
        logWarning,
      });
      recordSchemaVersion(db, 19);
    }

    if (currentVersion < 20) {
      applyMigrationV20MemoryRelations(db);
      recordSchemaVersion(db, 20);
    }

    if (currentVersion < 21) {
      applyMigrationV21StructuredMemories(db);
      recordSchemaVersion(db, 21);
    }

    if (currentVersion < 22) {
      applyMigrationV22QualityGateRepair(db, { copyQualityGateRowsToRepairedTable });
      recordSchemaVersion(db, 22);
    }

    if (currentVersion < 23) {
      applyMigrationV23MilestoneQueue(db);
      recordSchemaVersion(db, 23);
    }

    if (currentVersion < 24) {
      // v24: auto-mode coordination tables. See createCoordinationTablesV24
      // for full schema + invariants. No-op for fresh installs (the same
      // helper runs in the fresh-install path); for upgraded DBs this is
      // the only place these tables get created.
      createCoordinationTablesV24(db);
      recordSchemaVersion(db, 24);
    }

    if (currentVersion < 25) {
      // v25: runtime_kv non-correctness-critical key-value storage. See
      // createRuntimeKvTableV25 for the full schema + invariants.
      createRuntimeKvTableV25(db);
      recordSchemaVersion(db, 25);
    }

    if (currentVersion < 26) {
      applyMigrationV26MilestoneCommitAttributions(db);
      recordSchemaVersion(db, 26);
    }

    if (currentVersion < 27) {
      applyMigrationV27ArtifactHash(db);
      recordSchemaVersion(db, 27);
    }

    if (currentVersion < 28) {
      applyMigrationV28MemoryLastHitAt(db);
      recordSchemaVersion(db, 28);
    }

    if (currentVersion < 29) {
      applyMigrationV29RepositoryTargets(db);
      recordSchemaVersion(db, 29);
    }

    if (currentVersion < 30) {
      applyMigrationV30ReworkBriefs(db);
      recordSchemaVersion(db, 30);
    }

    if (currentVersion < 31) {
      applyMigrationV31CanonicalFoundation(db);
      recordSchemaVersion(db, 31);
    }

    if (currentVersion < 32) {
      applyMigrationV32LifecycleFoundation(db);
      recordSchemaVersion(db, 32);
    }

    if (currentVersion < 33) {
      applyMigrationV33ConversationFoundation(db);
      recordSchemaVersion(db, 33);
    }

    if (currentVersion < 34) {
      applyMigrationV34RecoveryEvidenceFoundation(db);
      recordSchemaVersion(db, 34);
    }

    if (currentVersion < 35) {
      applyMigrationV35ProjectionImportKernelCloseoutFoundation(db);
      recordSchemaVersion(db, 35);
    }

    if (currentVersion < 36) {
      // V36 triggers read the v24 coordination tables. Re-run their
      // idempotent creator first so upgrades remain safe when older schema
      // metadata exists but those prerequisite tables are missing.
      createCoordinationTablesV24(db);
      applyMigrationV36AttemptRecovery(db);
      recordSchemaVersion(db, 36);
    }

    if (currentVersion < 37) {
      applyMigrationV37TaskCancellation(db);
      recordSchemaVersion(db, 37);
    }

    if (currentVersion < 38) {
      applyMigrationV38TaskVerificationRecovery(db);
      recordSchemaVersion(db, 38);
    }

    if (currentVersion < 39) {
      applyMigrationV39TaskRecoveryCurrentHead(db);
      recordSchemaVersion(db, 39);
    }

    if (currentVersion < 40) {
      applyMigrationV40SliceCancellation(db);
      recordSchemaVersion(db, 40);
    }

    if (currentVersion < 41) {
      applyMigrationV41SliceCompletion(db);
      recordSchemaVersion(db, 41);
    }

    if (currentVersion < 42) {
      applyMigrationV42MilestoneValidation(db);
      recordSchemaVersion(db, 42);
    }

    if (currentVersion < 43) {
      applyMigrationV43MilestoneCompletion(db);
      recordSchemaVersion(db, 43);
    }

    if (currentVersion < 44) {
      applyMigrationV44MilestoneReopen(db);
      recordSchemaVersion(db, 44);
    }

    if (currentVersion < 45) {
      applyMigrationV45AuthorityRecovery(db);
      recordSchemaVersion(db, 45);
    }

    if (currentVersion < 46) {
      // V46 adds/alters NO tables — cutover stamps only (application_id,
      // user_version) so binaries and external tools can detect DB-authored
      // state cheaply.
      applyMigrationV46StateCutoverStamp(db);
    }

    if (currentVersion < 47) {
      // V47 — same-lease Attempt settlement (#1740): recreate the
      // dispatch-scope transition trigger so a worker holding its own lease
      // can settle its own Attempt after its dispatch row is gone.
      applyMigrationV47SameLeaseAttemptSettlement(db);
      stampStateCutoverPragmas(db, 47);
      recordSchemaVersion(db, 47);
    }

    if (currentVersion < 48) {
      applyMigrationV48TaskToolRequirements(db);
      stampStateCutoverPragmas(db, 48);
      recordSchemaVersion(db, 48);
    }

    if (currentVersion < 49) {
      // V49 — milestone.validate verdict scope relaxation (#2025): recreate
      // the technical-verdict scope trigger so a fully green verification
      // class can persist its 'pass' verdict while the aggregate outcome is
      // 'interrupted'. All other operations keep the pass⟺succeeded rule.
      applyMigrationV49MilestoneVerdictScope(db);
      stampStateCutoverPragmas(db, 49);
      recordSchemaVersion(db, 49);
    }

    if (currentVersion < 50) {
      // V50 — blocker-accepted operator closeout (#2202): the terminal Task
      // status enters the lifecycle CHECK (the table rebuild ran hoisted
      // above when needed) and the transition trigger gains the disposition
      // edges. When startupTransactionOpen is true the rebuild could not run;
      // the schema stays functional and blocker-accepted writes fail closed.
      applyMigrationV50BlockerAcceptedCloseout(db);
      stampStateCutoverPragmas(db, 50);
      recordSchemaVersion(db, 50);
    }

    if (_migrationFaultForTest) throw new Error("migration fault injected for test");

    db.exec(startupTransactionOpen ? "RELEASE SAVEPOINT schema_migration" : "COMMIT");
  } catch (err) {
    db.exec(startupTransactionOpen
      ? "ROLLBACK TO SAVEPOINT schema_migration; RELEASE SAVEPOINT schema_migration"
      : "ROLLBACK");
    throw err;
  }
}
let currentDb: DbAdapter | null = null;
let currentPath: string | null = null;
let currentPid: number = 0;
interface StartupCleanupState extends DatabaseMaintenanceCleanupState {
  readonly adapter: DbAdapter;
  exclusiveOwnershipHeld: boolean;
  adapterClosed: boolean;
}
let pendingStartupCleanup: StartupCleanupState | undefined;
let pendingDatabaseMaintenanceCleanup: DatabaseMaintenanceCleanupState | undefined;
let _exitHandlerRegistered = false;
const _dbOpenState = createDbOpenState();
const DB_OPEN_BUSY_BACKOFF_MS = [100, 200] as const;
const DB_OPEN_BUSY_SLEEP = new Int32Array(new SharedArrayBuffer(4));
let _databaseOpenAfterIntentCheckForTest: ((path: string) => void) | null = null;
let _startupInitializationBoundaryForTest: ((path: string) => void) | null = null;
type StartupRepairBoundaryPoint = "before-journal" | "after-journal" | "after-backup" | "before-vacuum";
let _startupRepairBoundaryForTest: ((point: StartupRepairBoundaryPoint, path: string) => void) | null = null;
let _startupReopenCloseForTest: ((adapter: DbAdapter) => void) | null = null;
let _startupExclusiveReleaseForTest: (() => void) | null = null;
let _startupSchemaDetectionForTest: (() => void) | null = null;
let _databaseOpenBeforeRawForTest: ((path: string) => void) | null = null;
let _databaseOpenAfterRawForTest: ((path: string) => void) | null = null;
let _probeAfterIntentCheckForTest: (() => void) | null = null;
let _maintenanceBeforeLockForTest: (() => void) | null = null;
let _maintenanceAfterClaimForTest: (() => void) | null = null;
let _maintenanceClaimBoundaryForTest: DatabaseMaintenanceClaimBoundary | null = null;

function ensureExitHandlerRegistered(): void {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.on("exit", () => {
    try { closeDatabase(); } catch (error) { logWarning("db", `exit handler close failed: ${(error as Error).message}`); }
  });
}

function quarantineStartupCleanup(cleanup: StartupCleanupState): void {
  if (pendingStartupCleanup !== undefined && pendingStartupCleanup.adapter !== cleanup.adapter) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Multiple startup cleanup handles cannot be retained");
  }
  pendingStartupCleanup = cleanup;
  ensureExitHandlerRegistered();
}

function cleanupStartupOwnership(cleanup: StartupCleanupState): void {
  if (cleanup.exclusiveOwnershipHeld) {
    releaseStartupExclusiveOwnership(cleanup.adapter);
    cleanup.exclusiveOwnershipHeld = false;
  }
  if (!cleanup.adapterClosed) {
    cleanup.adapter.close();
    cleanup.adapterClosed = true;
  }
  completeDatabaseMaintenanceCleanup(cleanup);
}

function completeDatabaseMaintenanceCleanup(
  cleanup: DatabaseMaintenanceCleanupState,
): void {
  if (cleanup.claim !== undefined) {
    releaseDatabaseMaintenance(cleanup.claim);
    cleanup.claim = undefined;
  }
  if (cleanup.projectionRelease !== undefined) {
    cleanup.projectionRelease();
    cleanup.projectionRelease = undefined;
  }
}

function quarantineDatabaseMaintenanceCleanup(
  cleanup: DatabaseMaintenanceCleanupState,
): void {
  if (
    pendingDatabaseMaintenanceCleanup !== undefined
    && pendingDatabaseMaintenanceCleanup !== cleanup
  ) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Multiple maintenance cleanup handles cannot be retained");
  }
  pendingDatabaseMaintenanceCleanup = cleanup;
  ensureExitHandlerRegistered();
}

function cleanupPendingDatabaseMaintenance(): void {
  if (pendingDatabaseMaintenanceCleanup === undefined) return;
  const cleanup = pendingDatabaseMaintenanceCleanup;
  completeDatabaseMaintenanceCleanup(cleanup);
  pendingDatabaseMaintenanceCleanup = undefined;
}

function cleanupPendingStartup(): void {
  if (pendingStartupCleanup === undefined) return;
  const cleanup = pendingStartupCleanup;
  cleanupStartupOwnership(cleanup);
  pendingStartupCleanup = undefined;
}

export function _setDatabaseOpenAfterIntentCheckForTest(
  hook: ((path: string) => void) | null,
): void {
  _databaseOpenAfterIntentCheckForTest = hook;
}
export function _setStartupInitializationBoundaryForTest(
  hook: ((path: string) => void) | null,
): void {
  _startupInitializationBoundaryForTest = hook;
}
export function _setStartupRepairBoundaryForTest(
  hook: ((point: StartupRepairBoundaryPoint, path: string) => void) | null,
): void {
  _startupRepairBoundaryForTest = hook;
}
export function _setStartupReopenCloseForTest(hook: ((adapter: DbAdapter) => void) | null): void {
  _startupReopenCloseForTest = hook;
}
export function _setStartupExclusiveReleaseForTest(hook: (() => void) | null): void {
  _startupExclusiveReleaseForTest = hook;
}
export function _setStartupSchemaDetectionForTest(hook: (() => void) | null): void {
  _startupSchemaDetectionForTest = hook;
}
export function _setDatabaseOpenAfterRawForTest(hook: ((path: string) => void) | null): void {
  _databaseOpenAfterRawForTest = hook;
}
export function _setDatabaseOpenBeforeRawForTest(hook: ((path: string) => void) | null): void {
  _databaseOpenBeforeRawForTest = hook;
}

export function _setProbeAfterIntentCheckForTest(hook: (() => void) | null): void {
  _probeAfterIntentCheckForTest = hook;
}

export function _setMaintenanceLockHooksForTest(hooks: {
  beforeLock?: () => void;
  afterClaim?: () => void;
  claimBoundary?: DatabaseMaintenanceClaimBoundary;
} | null): void {
  _maintenanceBeforeLockForTest = hooks?.beforeLock ?? null;
  _maintenanceAfterClaimForTest = hooks?.afterClaim ?? null;
  _maintenanceClaimBoundaryForTest = hooks?.claimBoundary ?? null;
}
/**
 * Identity key of the workspace whose connection is currently active
 * (currentDb). Set by openDatabaseByWorkspace(); null when the active
 * connection was opened via the legacy openDatabase(path) path.
 */
let _currentIdentityKey: string | null = null;

/**
 * Workspace-scoped connection cache.
 * Key: GsdWorkspace.identityKey (realpath-normalized project root).
 * Value: the DB path and open adapter for that workspace.
 *
 * Sibling worktrees of the same project share the same identityKey (set by
 * createWorkspace) and therefore reuse the same cached connection, preserving
 * shared-WAL semantics. Different projects get distinct cache entries.
 *
 * NOTE: Only one connection is "active" at a time (currentDb/currentPath).
 * The cache allows fast re-activation of a previously opened connection when
 * callers switch between known workspaces via openDatabaseByWorkspace().
 */
const _dbCache = createDbConnectionCache();
const _isolatedDatabases = new Map<DbAdapter, string>();
const _replacementObservationDatabases = new WeakSet<DbAdapter>();

export interface DatabaseReplacementToken {
  readonly kind: "gsd-database-replacement-token";
}

export interface DatabaseReplacementReceiptCapability {
  readonly kind: "gsd-database-replacement-receipt-capability";
}

export interface DatabaseReplacementFileIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface DatabaseReplacementReopenEvidence {
  readonly expectedPublishedSha256?: string;
  readonly persistedOriginalFileIdentity?: DatabaseReplacementFileIdentity;
  readonly expectedPublishedFileIdentity?: DatabaseReplacementFileIdentity;
  readonly expectedActiveIntentFileIdentity?: DatabaseReplacementFileIdentity;
  readonly expectedActiveIntentSha256?: string;
}

export type DatabaseReplacementBoundaryPoint =
  | "after-checkpoint"
  | "after-journal-mode"
  | "after-active-close"
  | "before-reopen-open"
  | "after-reopen-open"
  | "after-reopen-proof";

export type DatabaseReplacementBoundary = (
  point: DatabaseReplacementBoundaryPoint,
  evidence?: Readonly<Record<string, unknown>>,
) => void;

type FileIdentity = SqliteFileIdentity;

const _databaseAdapterFileIdentities = new WeakMap<DbAdapter, FileIdentity>();

function assertDatabaseAdapterMatchesPath(adapter: DbAdapter, databasePath: string): void {
  if (databasePath === ":memory:") return;
  const expected = _databaseAdapterFileIdentities.get(adapter);
  if (!expected || !sameFileIdentity(strictFileIdentity(databasePath, "canonical database"), expected)) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Open database handle is detached from the canonical database inode");
  }
}

function createFileBoundDatabaseAdapter(rawDb: unknown, databasePath: string, expected?: FileIdentity): DbAdapter {
  if (databasePath === ":memory:") return createDbAdapter(rawDb);
  const identity = expected ?? strictFileIdentity(databasePath, "canonical database");
  let adapterClosed = false;
  let identityReleased = false;
  let fileBoundAdapter: DbAdapter;
  const adapter = createDbAdapter(rawDb, () => assertDatabaseAdapterMatchesPath(fileBoundAdapter, databasePath));
  fileBoundAdapter = {
    ...adapter,
    close(): void {
      if (!adapterClosed) {
        adapter.close();
        adapterClosed = true;
      }
      if (!identityReleased) {
        identity.release?.();
        identityReleased = true;
      }
    },
  };
  _databaseAdapterFileIdentities.set(fileBoundAdapter, identity);
  return fileBoundAdapter;
}

function openCorrelatedRawDatabase(
  path: string,
  open: () => unknown,
  createIfMissing = true,
): { raw: unknown; identity?: FileIdentity } {
  if (path === ":memory:") return { raw: open() };
  const capture = captureSqliteOpenIdentity(path, createIfMissing);
  _databaseOpenBeforeRawForTest?.(path);
  let raw: unknown;
  try {
    raw = open();
  } catch (error) {
    releaseSqliteOpenIdentityCapture(capture);
    throw error;
  }
  if (raw === null || raw === undefined) {
    // No provider handle was opened (e.g. no SQLite provider available) —
    // release the identity capture and let the caller's `if (!rawDb)` guard
    // degrade gracefully instead of correlating a missing handle.
    releaseSqliteOpenIdentityCapture(capture);
    return { raw };
  }
  try {
    _databaseOpenAfterRawForTest?.(path);
    createDbAdapter(raw).exec("PRAGMA busy_timeout = 5000");
    const opened = correlateSqliteOpenIdentity(path, capture, raw);
    return { raw, identity: opened };
  } catch (error) {
    // The capture MUST be released even when closing the broken handle throws,
    // otherwise the Windows identity lock leaks an open file handle. The close
    // failure is secondary — retain the correlation failure for the caller.
    try {
      (raw as { close(): void }).close();
    } catch {
      // Retain the correlation failure below; the handle is already broken.
    } finally {
      releaseSqliteOpenIdentityCapture(capture);
    }
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database path changed while its handle opened", { cause: error });
  }
}

export const _openCorrelatedRawDatabaseForTest = openCorrelatedRawDatabase;

interface DatabaseReplacementTokenState {
  readonly databasePath: string;
  readonly activeIntentPath: string;
  readonly originalFileIdentity: FileIdentity;
  readonly activeIdentityKey: string | null;
  readonly cacheEntries: readonly {
    readonly key: string;
    readonly dbPath: string;
  }[];
}

const _databaseReplacementTokenStates = new WeakMap<
  DatabaseReplacementToken,
  DatabaseReplacementTokenState
>();
interface DatabaseReplacementReceiptCapabilityState {
  readonly databasePath: string;
  readonly activeIntentPath: string;
  readonly activeIntentFileIdentity: FileIdentity;
  readonly activeIntentSha256: string;
  readonly activeIntentHandle: number;
  readonly database: DbAdapter;
  readonly reopenedFileIdentity: FileIdentity;
  readonly postOpenDatabaseSha256: string;
}

const _databaseReplacementReceiptCapabilityStates = new WeakMap<
  DatabaseReplacementReceiptCapability,
  DatabaseReplacementReceiptCapabilityState
>();

/**
 * Close a descriptor without surfacing errors. Used for held intent descriptors
 * whose only remaining purpose is to be released; the file may already be gone.
 */
function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    /* best effort: the descriptor may already be closed or invalid */
  }
}

/**
 * Close any intent descriptor still held by a receipt capability that was
 * discarded without being consumed, so a leaked capability cannot leak an open
 * descriptor. The receipt path unregisters and closes its descriptor eagerly on
 * the success path; this only covers capabilities that are garbage collected.
 */
const _databaseReplacementIntentHandleRegistry = new FinalizationRegistry<number>(
  (descriptor) => { closeQuietly(descriptor); },
);
let _databaseReplacementWriteBypassDepth = 0;
const DATABASE_MAINTENANCE_SCHEMA_VERSION = 1 as const;
let selfProcessStartIdentity: string | null | undefined;

interface DatabaseMaintenanceIntent {
  readonly schemaVersion: 1;
  readonly ownerPid: number;
  readonly ownerProcessStartIdentity: string;
  readonly ownerNonce: string;
}

interface DatabaseMaintenanceClaim {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly intent: DatabaseMaintenanceIntent;
  readonly releaseProjectionClaim: () => void;
  publicationConfirmed: boolean;
  intentRemoved: boolean;
  intentDirectorySynced: boolean;
  projectionReleased: boolean;
}

type DatabaseMaintenanceClaimBoundaryPoint =
  | "after-maintenance-claim-write"
  | "after-maintenance-claim-file-sync"
  | "after-maintenance-claim-publish"
  | "after-maintenance-claim-directory-sync"
  | "after-maintenance-claim-temporary-unlink"
  | "after-maintenance-claim-cleanup-directory-sync"
  | "before-maintenance-claim-identity-proof"
  | "before-maintenance-intent-unlink"
  | "after-maintenance-intent-unlink"
  | "after-maintenance-intent-directory-sync"
  | "after-maintenance-projection-release";

type DatabaseMaintenanceClaimBoundary = (point: DatabaseMaintenanceClaimBoundaryPoint) => void;

function syncDirectory(path: string): void {
  if (process.platform === "win32") {
    syncDirectoryEntry(path);
    return;
  }
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requireSelfProcessStartIdentity(): string {
  if (selfProcessStartIdentity === undefined) {
    selfProcessStartIdentity = processStartIdentity(process.pid);
  }
  if (selfProcessStartIdentity === null) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Cannot prove the maintenance process identity");
  }
  return selfProcessStartIdentity;
}

function readDatabaseMaintenanceIntent(path: string): {
  readonly intent: DatabaseMaintenanceIntent;
  readonly identity: FileIdentity;
  readonly sha256: string;
} | null {
  if (!pathExistsFailClosed(path)) return null;
  const proof = strictFileProof(path, "database maintenance intent");
  let value: unknown;
  try {
    value = JSON.parse(proof.content.toString("utf8"));
  } catch (error) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance intent is malformed", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance intent is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [
    "ownerNonce", "ownerPid", "ownerProcessStartIdentity", "schemaVersion",
  ].join(",")
    || record["schemaVersion"] !== DATABASE_MAINTENANCE_SCHEMA_VERSION
    || !Number.isSafeInteger(record["ownerPid"])
    || Number(record["ownerPid"]) <= 0
    || typeof record["ownerProcessStartIdentity"] !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(record["ownerProcessStartIdentity"])
    || typeof record["ownerNonce"] !== "string"
    || !/^[0-9a-f-]{36}$/.test(record["ownerNonce"])) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance intent is invalid");
  }
  return {
    identity: proof.identity,
    sha256: proof.sha256,
    intent: {
      schemaVersion: 1,
      ownerPid: Number(record["ownerPid"]),
      ownerProcessStartIdentity: record["ownerProcessStartIdentity"],
      ownerNonce: record["ownerNonce"],
    },
  };
}

function databaseMaintenanceOwnerIsActive(intent: DatabaseMaintenanceIntent): boolean {
  if (intent.ownerPid === process.pid) {
    return intent.ownerProcessStartIdentity === requireSelfProcessStartIdentity();
  }
  try {
    process.kill(intent.ownerPid, 0);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ESRCH") return false;
  }
  const identity = processStartIdentity(intent.ownerPid);
  return identity === null || identity === intent.ownerProcessStartIdentity;
}

function databaseMaintenanceIntentIsActive(databasePath: string): boolean {
  const path = databaseMaintenanceIntentPath(databasePath);
  const existing = readDatabaseMaintenanceIntent(path);
  if (existing === null) return false;
  if (databaseMaintenanceOwnerIsActive(existing.intent)) return true;
  removeExactMaintenanceIntent(path, existing.identity, existing.sha256);
  return false;
}

function removeExactMaintenanceIntent(path: string, identity: FileIdentity, sha256: string): void {
  // Prove the marker by identity AND content before deleting it. An unlink+rewrite
  // that reuses the just-freed inode number would satisfy an identity-only check
  // while substituting a foreign owner's bytes, so a content proof is required to
  // avoid deleting another process's marker under inode-number reuse.
  const proof = strictFileProof(path, "database maintenance intent");
  if (!sameFileIdentity(proof.identity, identity) || proof.sha256 !== sha256) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance intent changed before cleanup");
  }
  unlinkSync(path);
  syncDirectory(dirname(path));
}

export function assertDatabaseMaintenanceAllowsReplacement(databasePath: string): void {
  const path = databaseMaintenanceIntentPath(databasePath);
  const existing = readDatabaseMaintenanceIntent(path);
  if (existing === null) return;
  if (databaseMaintenanceOwnerIsActive(existing.intent)) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance is already active");
  }
  removeExactMaintenanceIntent(path, existing.identity, existing.sha256);
}

function claimDatabaseMaintenance(
  databasePath: string,
  maintenance: DatabaseMaintenanceCleanupState,
): void {
  const releaseProjectionClaim = claimProjectionMaintenance(databasePath);
  maintenance.projectionRelease = releaseProjectionClaim;
  const path = databaseMaintenanceIntentPath(databasePath);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const intent: DatabaseMaintenanceIntent = {
    schemaVersion: 1,
    ownerPid: process.pid,
    ownerProcessStartIdentity: requireSelfProcessStartIdentity(),
    ownerNonce: randomUUID(),
  };
  const serializedIntent = JSON.stringify(intent);
  const publishedSha256 = `sha256:${createHash("sha256").update(Buffer.from(serializedIntent, "utf8")).digest("hex")}`;
  let descriptor: number | undefined;
  try {
    assertDatabaseMaintenanceAllowsReplacement(databasePath);
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, serializedIntent, "utf8");
    _maintenanceClaimBoundaryForTest?.("after-maintenance-claim-write");
    fsyncSync(descriptor);
    _maintenanceClaimBoundaryForTest?.("after-maintenance-claim-file-sync");
    closeSync(descriptor);
    descriptor = undefined;
    const publishedIdentity = strictFileIdentity(temporary, "database maintenance intent staging file");
    linkSync(temporary, path);
    const claim: DatabaseMaintenanceClaim = {
      path,
      identity: publishedIdentity,
      sha256: publishedSha256,
      intent,
      releaseProjectionClaim,
      publicationConfirmed: false,
      intentRemoved: false,
      intentDirectorySynced: false,
      projectionReleased: false,
    };
    maintenance.claim = claim;
    maintenance.projectionRelease = undefined;
    _maintenanceClaimBoundaryForTest?.("after-maintenance-claim-publish");
    syncDirectory(dirname(path));
    _maintenanceClaimBoundaryForTest?.("after-maintenance-claim-directory-sync");
    unlinkSync(temporary);
    _maintenanceClaimBoundaryForTest?.("after-maintenance-claim-temporary-unlink");
    syncDirectory(dirname(path));
    _maintenanceClaimBoundaryForTest?.("after-maintenance-claim-cleanup-directory-sync");
    _maintenanceClaimBoundaryForTest?.("before-maintenance-claim-identity-proof");
    // Prove the published intent by identity AND content: an unlink+rewrite that
    // reuses the just-freed inode number (common on some filesystems) would pass
    // an identity-only check while substituting foreign bytes, so a content proof
    // is required to fail closed instead of later reading a malformed intent.
    const publicationProof = strictFileProof(path, "database maintenance intent");
    if (
      !sameFileIdentity(publicationProof.identity, publishedIdentity)
      || publicationProof.sha256 !== publishedSha256
    ) {
      throw new GSDError(
        GSD_STALE_STATE,
        "gsd-db: Database maintenance intent changed before publication completed",
      );
    }
    claim.publicationConfirmed = true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain original */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* retain original */ }
    try { completeDatabaseMaintenanceCleanup(maintenance); } catch {}
    throw error;
  }
}

function acquireDatabaseMaintenance(databasePath: string): DatabaseMaintenanceCleanupState {
  cleanupPendingDatabaseMaintenance();
  const maintenance: DatabaseMaintenanceCleanupState = {
    claim: undefined,
    projectionRelease: undefined,
  };
  try {
    claimDatabaseMaintenance(databasePath, maintenance);
    return maintenance;
  } catch (error) {
    try {
      completeDatabaseMaintenanceCleanup(maintenance);
    } catch (cleanupError) {
      quarantineDatabaseMaintenanceCleanup(maintenance);
      logWarning("db", `maintenance acquisition cleanup failed: ${(cleanupError as Error).message}`);
    }
    throw error;
  }
}

function releaseDatabaseMaintenanceCleanup(maintenance: DatabaseMaintenanceCleanupState): void {
  try {
    completeDatabaseMaintenanceCleanup(maintenance);
  } catch (error) {
    quarantineDatabaseMaintenanceCleanup(maintenance);
    throw error;
  }
}

function releaseDatabaseMaintenance(claim: DatabaseMaintenanceClaim): void {
  if (!claim.publicationConfirmed && !claim.intentRemoved) {
    if (!pathExistsFailClosed(claim.path)) {
      claim.intentRemoved = true;
    } else {
      const proof = strictFileProof(claim.path, "database maintenance intent");
      if (!sameFileIdentity(proof.identity, claim.identity) || proof.sha256 !== claim.sha256) {
        claim.intentRemoved = true;
      }
    }
  }
  if (!claim.intentRemoved) {
    const current = readDatabaseMaintenanceIntent(claim.path);
    if (current === null) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance intent disappeared before release");
    }
    if (JSON.stringify(current.intent) !== JSON.stringify(claim.intent)) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance ownership changed before release");
    }
    const proof = strictFileProof(claim.path, "database maintenance intent");
    if (!sameFileIdentity(proof.identity, claim.identity) || proof.sha256 !== claim.sha256) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Database maintenance intent changed before cleanup");
    }
    _maintenanceClaimBoundaryForTest?.("before-maintenance-intent-unlink");
    unlinkSync(claim.path);
    claim.intentRemoved = true;
    _maintenanceClaimBoundaryForTest?.("after-maintenance-intent-unlink");
  }
  if (!claim.intentDirectorySynced) {
    syncDirectory(dirname(claim.path));
    claim.intentDirectorySynced = true;
    _maintenanceClaimBoundaryForTest?.("after-maintenance-intent-directory-sync");
  }
  if (!claim.projectionReleased) {
    claim.releaseProjectionClaim();
    claim.projectionReleased = true;
    _maintenanceClaimBoundaryForTest?.("after-maintenance-projection-release");
  }
}

function pathExistsFailClosed(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: Cannot inspect database replacement fence at ${path}`,
      { cause: error },
    );
  }
}

function strictFileIdentity(path: string, label: string): FileIdentity {
  let file;
  try {
    file = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Cannot inspect ${label} at ${path}`, { cause: error });
  }
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: ${label} must be a real regular file`);
  }
  return Object.freeze({ device: file.dev, inode: file.ino });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function strictFileProof(path: string, label: string): {
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly content: Buffer;
} {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fileDescriptor, { bigint: true });
    if (!before.isFile()) {
      throw new GSDError(GSD_STALE_STATE, `gsd-db: ${label} must be a real regular file`);
    }
    const content = readFileSync(fileDescriptor);
    const after = fstatSync(fileDescriptor, { bigint: true });
    const beforeIdentity = Object.freeze({ device: before.dev, inode: before.ino });
    const afterIdentity = Object.freeze({ device: after.dev, inode: after.ino });
    if (!sameFileIdentity(beforeIdentity, afterIdentity) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new GSDError(GSD_STALE_STATE, `gsd-db: ${label} changed while it was inspected`);
    }
    return Object.freeze({
      identity: beforeIdentity,
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      content,
    });
  } catch (error) {
    if (error instanceof GSDError) throw error;
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Cannot inspect ${label} at ${path}`, { cause: error });
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function requireExactFileProof(
  path: string,
  label: string,
  expectedIdentity: FileIdentity,
  expectedSha256: string,
): void {
  const proof = strictFileProof(path, label);
  if (!sameFileIdentity(proof.identity, expectedIdentity) || proof.sha256 !== expectedSha256) {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: ${label} does not match the replacement proof`);
  }
}

/**
 * Open and prove the replacement intent, returning a descriptor that stays open
 * for the life of the receipt capability. Holding the descriptor lets a later
 * unlink+rewrite be detected even when the rewrite reuses the freed inode
 * number: the held descriptor's link count drops to zero when the original file
 * is unlinked, which an identity-and-content re-proof cannot observe under
 * inode-number reuse. The descriptor is closed if the proof fails.
 */
function openProvenReplacementIntentHandle(
  path: string,
  expectedIdentity: FileIdentity,
  expectedSha256: string,
): number {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile()) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: database replacement intent must be a real regular file");
    }
    const identity = Object.freeze({ device: stat.dev, inode: stat.ino });
    const sha256 = `sha256:${createHash("sha256").update(readFileSync(descriptor)).digest("hex")}`;
    if (!sameFileIdentity(identity, expectedIdentity) || sha256 !== expectedSha256) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: database replacement intent does not match the replacement proof");
    }
    return descriptor;
  } catch (error) {
    closeQuietly(descriptor);
    throw error;
  }
}

/**
 * Assert that the descriptor held for the receipt capability still names the
 * live intent file. A swap that unlinks the intent and rewrites it drops the
 * held descriptor's link count to zero (even if the rewrite reuses the freed
 * inode number); a replacement by a different inode changes the live identity.
 * Both fail closed with a "replacement proof" message so callers can classify
 * them alongside the content proof.
 */
function assertReplacementIntentHandleIsLive(state: DatabaseReplacementReceiptCapabilityState): void {
  let stat;
  try {
    stat = fstatSync(state.activeIntentHandle, { bigint: true });
  } catch (error) {
    throw new GSDError(
      GSD_STALE_STATE,
      "gsd-db: database replacement intent does not match the replacement proof",
      { cause: error },
    );
  }
  if (stat.nlink === 0n) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: database replacement intent does not match the replacement proof");
  }
  const liveIdentity = strictFileIdentity(state.activeIntentPath, "database replacement intent");
  if (!sameFileIdentity(liveIdentity, state.activeIntentFileIdentity)) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: database replacement intent does not match the replacement proof");
  }
}

function parseFileIdentity(value: DatabaseReplacementFileIdentity, label: string): FileIdentity {
  try {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value.device) || !/^(?:0|[1-9][0-9]*)$/.test(value.inode)) {
      throw new Error("invalid identity");
    }
    return Object.freeze({ device: BigInt(value.device), inode: BigInt(value.inode) });
  } catch (error) {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Invalid ${label}`, { cause: error });
  }
}

function requireExpectedSha256(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Replacement reopen requires an exact ${label} SHA-256`);
  }
  return value;
}

function assertReopenedDatabaseHandleMatchesPath(
  db: DbAdapter,
  databasePath: string,
  expectedIdentity: FileIdentity,
  expectedSha256: string,
): ReturnType<typeof strictFileProof> {
  const proof = strictFileProof(databasePath, "replacement database");
  if (!sameFileIdentity(proof.identity, expectedIdentity) || proof.sha256 !== expectedSha256) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Replacement database changed while it reopened");
  }

  try {
    assertDatabaseAdapterMatchesPath(db, databasePath);
  } catch (error) {
    throw new GSDError(
      GSD_STALE_STATE,
      "gsd-db: reopened SQLite handle does not match the replacement database",
      { cause: error },
    );
  }
  requireExactFileProof(databasePath, "replacement database", proof.identity, proof.sha256);
  return proof;
}

function assertDatabaseReplacementFenceAllowsWrite(): void {
  if (_databaseReplacementWriteBypassDepth > 0 || !currentPath || currentPath === ":memory:") return;
  assertDatabaseReplacementFenceAllowsPath(currentPath);
  assertDatabaseMaintenanceFenceAllowsWrite(currentPath);
}

function assertDatabaseReplacementFenceAllowsPath(databasePath: string): void {
  if (_databaseReplacementWriteBypassDepth > 0 || databasePath === ":memory:") return;
  const { activeIntentPath } = getDatabaseReplacementPaths(databasePath);
  if (pathExistsFailClosed(activeIntentPath)) {
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: Database writes are fenced while replacement intent exists at ${activeIntentPath}`,
    );
  }
}

function databaseReplacementIntentExists(databasePath: string): boolean {
  if (databasePath === ":memory:") return false;
  return pathExistsFailClosed(getDatabaseReplacementPaths(databasePath).activeIntentPath);
}

/**
 * Permit the live-restore owner to record its receipt while its write fence is
 * present. The callback is deliberately synchronous so the bypass cannot leak
 * into unrelated event-loop work.
 */
export function withDatabaseReplacementWriteBypass<T>(
  capability: DatabaseReplacementReceiptCapability,
  fn: () => T,
): T {
  const state = _databaseReplacementReceiptCapabilityStates.get(capability);
  if (!state) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Invalid or consumed database replacement receipt capability");
  }
  if (_databaseReplacementWriteBypassDepth !== 0) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement receipt capability is already in use");
  }
  if (
    currentDb !== state.database
    || !currentPath
    || resolve(currentPath) !== state.databasePath
  ) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement receipt capability does not match the active database");
  }
  const currentDatabaseProof = strictFileProof(state.databasePath, "replacement database");
  if (
    !sameFileIdentity(currentDatabaseProof.identity, state.reopenedFileIdentity)
    || currentDatabaseProof.sha256 !== state.postOpenDatabaseSha256
  ) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Replacement database changed before its receipt transaction");
  }
  assertReplacementIntentHandleIsLive(state);
  requireExactFileProof(
    state.activeIntentPath,
    "database replacement intent",
    state.activeIntentFileIdentity,
    state.activeIntentSha256,
  );

  _databaseReplacementWriteBypassDepth++;
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement bypass callback must be synchronous");
    }
    assertReplacementIntentHandleIsLive(state);
    requireExactFileProof(
      state.activeIntentPath,
      "database replacement intent",
      state.activeIntentFileIdentity,
      state.activeIntentSha256,
    );
    if (
      currentDb !== state.database
      || !currentPath
      || resolve(currentPath) !== state.databasePath
      || !sameFileIdentity(
        strictFileIdentity(state.databasePath, "replacement database"),
        state.reopenedFileIdentity,
      )
    ) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement changed while recording its receipt");
    }
    _databaseReplacementReceiptCapabilityStates.delete(capability);
    _databaseReplacementIntentHandleRegistry.unregister(capability);
    closeQuietly(state.activeIntentHandle);
    return result;
  } finally {
    _databaseReplacementWriteBypassDepth--;
  }
}

/** Revalidate the exact recovery intent from inside the receipt transaction. */
export function assertDatabaseReplacementReceiptIntent(
  capability: DatabaseReplacementReceiptCapability,
): void {
  const state = _databaseReplacementReceiptCapabilityStates.get(capability);
  if (!state) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Invalid or consumed database replacement receipt capability");
  }
  assertReplacementIntentHandleIsLive(state);
  requireExactFileProof(
    state.activeIntentPath,
    "database replacement intent",
    state.activeIntentFileIdentity,
    state.activeIntentSha256,
  );
}

function strictRealDatabasePath(path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0 || path === ":memory:") {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: ${label} must be a file-backed database path`);
  }
  const resolvedPath = resolve(path);
  strictFileIdentity(resolvedPath, label);
  return realpathSync(resolvedPath);
}

function ownDataValue(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new GSDError(GSD_STALE_STATE, `gsd-db: Invalid ${key} value from SQLite replacement preflight`);
  }
  return descriptor.value;
}

function assertActiveDatabaseList(db: DbAdapter, expectedRealPath: string): void {
  const rows = db.prepare("PRAGMA database_list").all();
  const row = rows.find((entry) => ownDataValue(entry, "name") === "main");
  if (!row || rows.some((entry) => {
    const name = ownDataValue(entry, "name");
    const file = ownDataValue(entry, "file");
    return name !== "main" && !(name === "temp" && file === "");
  })) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement requires one main database and no attached files");
  }
  const seq = ownDataValue(row, "seq");
  const name = ownDataValue(row, "name");
  const file = ownDataValue(row, "file");
  if (seq !== 0 || name !== "main" || typeof file !== "string" || realpathSync(file) !== expectedRealPath) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Active SQLite database does not match the replacement target");
  }
}

function checkpointForDatabaseReplacement(db: DbAdapter): void {
  const rows = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
  if (rows.length !== 1) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Database replacement checkpoint returned an invalid result");
  }
  const row = rows[0]!;
  const busy = ownDataValue(row, "busy");
  const log = ownDataValue(row, "log");
  const checkpointed = ownDataValue(row, "checkpointed");
  const completed = busy === 0
    && Number.isSafeInteger(log)
    && Number.isSafeInteger(checkpointed)
    && ((log === -1 && checkpointed === -1) || (typeof log === "number" && log >= 0 && checkpointed === log));
  if (!completed) {
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: Database replacement requires a complete TRUNCATE checkpoint; observed ${String(busy)}/${String(log)}/${String(checkpointed)}`,
    );
  }
}

/**
 * Strictly detach every in-process handle for the active replacement target.
 * The returned token is accepted only by reopenDatabaseAfterReplacement().
 */
export function detachActiveDatabaseForReplacement(
  expectedPath: string,
  boundary?: DatabaseReplacementBoundary,
): DatabaseReplacementToken {
  if (!currentDb || !currentPath) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No active database to detach for replacement");
  }
  if (_transactionRunner.isInTransaction()) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Cannot detach the database during an active transaction");
  }

  const expectedResolvedPath = resolve(expectedPath);
  const databasePath = strictRealDatabasePath(expectedResolvedPath, "replacement target");
  if (strictRealDatabasePath(currentPath, "active database") !== databasePath) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Active database path does not match the replacement target");
  }
  const activeIntentPath = getDatabaseReplacementPaths(databasePath).activeIntentPath;
  strictFileIdentity(activeIntentPath, "database replacement intent");
  const originalFileIdentity = strictFileIdentity(databasePath, "replacement target");
  assertActiveDatabaseList(currentDb, databasePath);

  const targetCacheEntries: { key: string; dbPath: string; db: DbAdapter }[] = [];
  for (const [key, entry] of _dbCache.asReadonlyMap()) {
    let matchesTarget = entry.db === currentDb || resolve(entry.dbPath) === expectedResolvedPath;
    if (!matchesTarget) {
      try {
        matchesTarget = realpathSync(entry.dbPath) === databasePath;
      } catch {
        matchesTarget = false;
      }
    }
    if (matchesTarget) targetCacheEntries.push({ key, ...entry });
  }

  for (const [database, isolatedPath] of [..._isolatedDatabases]) {
    if (isolatedPath === databasePath) database.close();
  }
  const adapters = new Set(targetCacheEntries.map((entry) => entry.db));
  adapters.delete(currentDb);
  for (const adapter of adapters) adapter.close();
  for (const { key, db } of targetCacheEntries) {
    if (db !== currentDb) _dbCache.delete(key);
  }
  checkpointForDatabaseReplacement(currentDb);
  boundary?.("after-checkpoint");
  const journalMode = currentDb.prepare("PRAGMA journal_mode=DELETE").get()?.["journal_mode"];
  if (journalMode !== "delete") {
    throw new GSDError(
      GSD_STALE_STATE,
      `gsd-db: Database replacement requires DELETE journal mode before detach; observed ${String(journalMode)}`,
    );
  }
  boundary?.("after-journal-mode");

  currentDb.close();

  const tokenState: DatabaseReplacementTokenState = {
    databasePath,
    activeIntentPath,
    originalFileIdentity,
    activeIdentityKey: _currentIdentityKey,
    cacheEntries: targetCacheEntries.map(({ key, dbPath }) => ({ key, dbPath })),
  };
  for (const { key } of targetCacheEntries) _dbCache.delete(key);
  currentDb = null;
  currentPath = null;
  currentPid = 0;
  _currentIdentityKey = null;
  _dbOpenState.reset();

  const token: DatabaseReplacementToken = Object.freeze({ kind: "gsd-database-replacement-token" });
  _databaseReplacementTokenStates.set(token, tokenState);
  try {
    boundary?.("after-active-close");
  } catch (error) {
    try {
      reopenDatabaseAfterReplacement(token);
    } catch (reopenError) {
      throw new GSDError(
        GSD_STALE_STATE,
        "gsd-db: Database replacement boundary failed after close and the original database could not reopen",
        { cause: reopenError },
      );
    }
    throw error;
  }
  return token;
}

function createDatabaseReplacementReceiptCapability(
  state: DatabaseReplacementReceiptCapabilityState,
): DatabaseReplacementReceiptCapability {
  const capability: DatabaseReplacementReceiptCapability = Object.freeze({
    kind: "gsd-database-replacement-receipt-capability",
  });
  _databaseReplacementReceiptCapabilityStates.set(capability, state);
  return capability;
}

function abandonFailedReplacementReopen(error: unknown): never {
  const database = currentDb;
  currentDb = null;
  currentPath = null;
  currentPid = 0;
  _currentIdentityKey = null;
  _dbOpenState.reset();
  try {
    database?.close();
  } catch (closeError) {
    throw new GSDError(
      GSD_STALE_STATE,
      "gsd-db: Replacement database proof failed and its reopened connection could not be closed",
      { cause: closeError },
    );
  }
  throw error;
}

/**
 * Reopen a successfully detached database and restore its workspace identity.
 * A changed inode plus exact publication evidence returns a single-use receipt
 * capability. A same-inode reopen normally restores the original connection;
 * persisted evidence can additionally prove that the process detached an
 * already-published file while converging a prior interrupted receipt.
 */
export function reopenDatabaseAfterReplacement(
  token: DatabaseReplacementToken,
  evidence: DatabaseReplacementReopenEvidence = {},
  boundary?: DatabaseReplacementBoundary,
): DatabaseReplacementReceiptCapability | null {
  const tokenState = _databaseReplacementTokenStates.get(token);
  if (!tokenState) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Invalid or consumed database replacement token");
  }
  if (currentDb) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Cannot reopen replacement while another database is active");
  }
  strictRealDatabasePath(tokenState.databasePath, "replacement database");
  const preOpenDatabaseProof = strictFileProof(tokenState.databasePath, "replacement database");
  const reopenedFileIdentity = preOpenDatabaseProof.identity;
  const replacementWasPublished = !sameFileIdentity(
    tokenState.originalFileIdentity,
    reopenedFileIdentity,
  );
  let receiptAuthorized = replacementWasPublished;
  let authorizedIntentProof: {
    readonly identity: FileIdentity;
    readonly sha256: string;
  } | null = null;
  if (replacementWasPublished) {
    const expectedSha256 = requireExpectedSha256(evidence.expectedPublishedSha256, "published database");
    if (preOpenDatabaseProof.sha256 !== expectedSha256) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Published replacement does not match its expected SHA-256");
    }
    if (evidence.persistedOriginalFileIdentity) {
      const persistedOriginal = parseFileIdentity(evidence.persistedOriginalFileIdentity, "persisted original database identity");
      if (!sameFileIdentity(persistedOriginal, tokenState.originalFileIdentity)) {
        throw new GSDError(GSD_STALE_STATE, "gsd-db: Persisted original database identity does not match the detached database");
      }
    }
    if (evidence.expectedPublishedFileIdentity) {
      const expectedPublished = parseFileIdentity(evidence.expectedPublishedFileIdentity, "expected published database identity");
      if (!sameFileIdentity(expectedPublished, reopenedFileIdentity)) {
        throw new GSDError(GSD_STALE_STATE, "gsd-db: Published replacement does not match its expected file identity");
      }
    }
  } else if (
    evidence.persistedOriginalFileIdentity
    && evidence.expectedPublishedFileIdentity
    && evidence.expectedPublishedSha256
  ) {
    // Validate that all three evidence fields are present and well-formed; the
    // persisted-original identity is parsed for its shape only. Under inode-number
    // reuse the freed pre-restore original can be reassigned to the newly
    // published candidate, so the persisted original may share the reopened inode
    // even on a correct recovery. Requiring them to differ would reject that valid
    // case, so authorization rests on the robust proof instead: the reopened file
    // matches the expected published identity and its exact content.
    parseFileIdentity(evidence.persistedOriginalFileIdentity, "persisted original database identity");
    const expectedPublished = parseFileIdentity(evidence.expectedPublishedFileIdentity, "expected published database identity");
    const expectedSha256 = requireExpectedSha256(evidence.expectedPublishedSha256, "published database");
    receiptAuthorized = sameFileIdentity(expectedPublished, reopenedFileIdentity)
      && preOpenDatabaseProof.sha256 === expectedSha256;
    if (!receiptAuthorized) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Same-inode recovery does not match the persisted publication proof");
    }
  } else if (
    evidence.expectedPublishedSha256
    || evidence.persistedOriginalFileIdentity
    || evidence.expectedPublishedFileIdentity
    || evidence.expectedActiveIntentFileIdentity
    || evidence.expectedActiveIntentSha256
  ) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Same-inode recovery evidence is incomplete");
  }
  let authorizedIntentHandle: number | undefined;
  if (receiptAuthorized) {
    if (!evidence.expectedActiveIntentFileIdentity) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Replacement reopen requires the published intent file identity");
    }
    const expectedIntentIdentity = parseFileIdentity(
      evidence.expectedActiveIntentFileIdentity,
      "expected active intent identity",
    );
    const expectedIntentSha256 = requireExpectedSha256(
      evidence.expectedActiveIntentSha256,
      "active intent",
    );
    // Hold an open descriptor on the proven intent for the life of the receipt
    // capability instead of only re-proving it later by identity and content: an
    // unlink+rewrite that reuses the freed inode number would pass a re-proof but
    // still drops this descriptor's link count to zero, so the receipt path fails
    // closed. The descriptor is closed on every failure path below and on the
    // consumption path in withDatabaseReplacementWriteBypass.
    authorizedIntentHandle = openProvenReplacementIntentHandle(
      tokenState.activeIntentPath,
      expectedIntentIdentity,
      expectedIntentSha256,
    );
    authorizedIntentProof = Object.freeze({ identity: expectedIntentIdentity, sha256: expectedIntentSha256 });
  }
  try {
    boundary?.("before-reopen-open");
    if (!openDatabaseInternal(tokenState.databasePath, true) || !currentDb) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Replacement database did not reopen");
    }
    let postOpenDatabaseProof;
    try {
      boundary?.("after-reopen-open");
      postOpenDatabaseProof = assertReopenedDatabaseHandleMatchesPath(
        currentDb,
        tokenState.databasePath,
        reopenedFileIdentity,
        preOpenDatabaseProof.sha256,
      );
      boundary?.("after-reopen-proof");
    } catch (error) {
      abandonFailedReplacementReopen(error);
    }

    for (const entry of tokenState.cacheEntries) {
      _dbCache.set(entry.key, { dbPath: entry.dbPath, db: currentDb });
    }
    _currentIdentityKey = tokenState.activeIdentityKey;
    _databaseReplacementTokenStates.delete(token);
    if (!receiptAuthorized) return null;
    if (!authorizedIntentProof || authorizedIntentHandle === undefined) {
      throw new GSDError(GSD_STALE_STATE, "gsd-db: Replacement receipt authorization proof is missing");
    }
    const capability = createDatabaseReplacementReceiptCapability({
      databasePath: tokenState.databasePath,
      activeIntentPath: tokenState.activeIntentPath,
      activeIntentFileIdentity: authorizedIntentProof.identity,
      activeIntentSha256: authorizedIntentProof.sha256,
      activeIntentHandle: authorizedIntentHandle,
      database: currentDb,
      reopenedFileIdentity,
      postOpenDatabaseSha256: postOpenDatabaseProof.sha256,
    });
    _databaseReplacementIntentHandleRegistry.register(capability, authorizedIntentHandle, capability);
    authorizedIntentHandle = undefined;
    return capability;
  } catch (error) {
    if (authorizedIntentHandle !== undefined) {
      closeQuietly(authorizedIntentHandle);
    }
    throw error;
  }
}

/** Test helper: expose the internal cache for inspection. Not for production use. */
export function _getDbCache(): ReadonlyMap<string, DbConnectionCacheEntry> {
  return _dbCache.asReadonlyMap();
}

function closeCachedConnection(entry: DbConnectionCacheEntry, source: "all" | "workspace"): void {
  try {
    entry.db.close();
  } catch (e) {
    if (source === "workspace") logWarning("db", `database close (byWorkspace) failed: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Close and evict every entry in the workspace connection cache, then call
 * closeDatabase() to close the active connection.
 *
 * Use this for test teardown or process-shutdown paths where every open
 * connection must be flushed. Normal callers should use closeDatabase() or
 * closeDatabaseByWorkspace() instead.
 */
export function closeAllDatabases(): void {
  for (const database of [..._isolatedDatabases.keys()]) database.close();
  // Close all non-active cached connections first.
  _dbCache.closeNonActive(currentDb, (entry) => closeCachedConnection(entry, "all"));
  closeDatabase();
}

/**
 * Open (or reuse) the database connection scoped to the given workspace.
 *
 * Uses workspace.identityKey as the cache key, so sibling worktrees of the
 * same project resolve to the same connection. On a cache hit with complete
 * startup invariants, the existing adapter is reactivated without re-opening
 * the file. A cache hit that needs repair is closed and reopened through the
 * guarded schema-init flow. On a cache miss, delegates to openDatabase() for
 * the full open + schema-init + migration flow, then caches the result.
 *
 * When switching to a different workspace, the previously active connection
 * is preserved in the cache (not closed), so callers can switch back to it
 * cheaply via a subsequent openDatabaseByWorkspace() call.
 *
 * @param workspace A GsdWorkspace created by createWorkspace().
 * @returns true if the connection is open and ready, false otherwise.
 */
export function openDatabaseByWorkspace(workspace: GsdWorkspace): boolean {
  const key = workspace.identityKey;
  const dbPath = workspace.contract.projectDb;

  const cached = _dbCache.get(key);
  if (cached) {
    try {
      assertDatabaseAdapterMatchesPath(cached.db, cached.dbPath);
    } catch {
      if (currentDb === cached.db) closeDatabase();
      else {
        closeCachedConnection(cached, "workspace");
        _dbCache.delete(key);
      }
    }
  }
  const validCached = _dbCache.get(key);
  if (validCached) {
    if (_replacementObservationDatabases.has(validCached.db) || !assessStartupRepair(validCached.db).required) {
      currentDb = validCached.db;
      currentPath = validCached.dbPath;
      currentPid = process.pid;
      _dbOpenState.markAttempted();
      _currentIdentityKey = key;
      return true;
    }
    if (currentDb === validCached.db) closeDatabase();
    else {
      closeCachedConnection(validCached, "workspace");
      _dbCache.delete(key);
    }
  }

  // Cache miss — need to open a new connection.
  //
  // If there is a currently active workspace connection, stash it in the
  // cache under its identity key before calling openDatabase(), because
  // openDatabase() will call closeDatabase() when the path changes (which
  // would destroy the existing adapter). By nulling out currentDb first,
  // we prevent openDatabase() from closing the live adapter.
  let oldDb: typeof currentDb = null;
  let oldPath: typeof currentPath = null;
  let oldPid: typeof currentPid = 0;
  let oldKey: typeof _currentIdentityKey = null;

  if (currentDb !== null && _currentIdentityKey !== null) {
    // Snapshot the old globals so we can restore them on failure.
    oldDb = currentDb;
    oldPath = currentPath;
    oldPid = currentPid;
    oldKey = _currentIdentityKey;
    // Save the current connection so it stays alive in the cache.
    _dbCache.set(_currentIdentityKey, {
      dbPath: currentPath!,
      db: currentDb,
    });
    // Detach from globals so openDatabase() opens fresh without closing it.
    currentDb = null;
    currentPath = null;
    currentPid = 0;
    _currentIdentityKey = null;
  }

  // Run the full open/schema/migration flow for the new workspace.
  // openDatabase() can throw on corrupt DB or permission error — catch so we
  // can restore the previous connection rather than leaving globals null.
  let opened: boolean;
  try {
    opened = openDatabase(dbPath);
  } catch (err) {
    // Failed to open the new DB. Restore the previous workspace connection so
    // the caller's workspace remains active (it is still safe in _dbCache).
    if (oldDb !== null) {
      currentDb = oldDb;
      currentPath = oldPath;
      currentPid = oldPid;
      _currentIdentityKey = oldKey;
    }
    throw err;
  }
  if (opened && currentDb) {
    _dbCache.set(key, { dbPath, db: currentDb });
    _currentIdentityKey = key;
  } else if (!opened && oldDb !== null) {
    // Restore the previous connection so the caller's workspace remains active.
    // The failed attempt left no live adapter, so the globals stayed null.
    currentDb = oldDb;
    currentPath = oldPath;
    currentPid = oldPid;
    _currentIdentityKey = oldKey;
  }
  return opened;
}

/**
 * Open (or reuse) the database connection scoped to the workspace in a
 * MilestoneScope. Thin delegation to openDatabaseByWorkspace().
 */
export function openDatabaseByScope(scope: MilestoneScope): boolean {
  return openDatabaseByWorkspace(scope.workspace);
}

/**
 * Close the database connection for the given workspace and remove it from
 * the cache. If the workspace's connection is currently active (currentDb),
 * performs a full guarded closeDatabase(). Otherwise only
 * removes the cache entry (the adapter was already replaced by a later open).
 */
export function closeDatabaseByWorkspace(workspace: GsdWorkspace): void {
  const key = workspace.identityKey;
  const cached = _dbCache.get(key);
  if (!cached) return;

  if (currentDb === cached.db) {
    // This workspace's connection is the active one — full close.
    closeDatabase();
  } else {
    // Connection was displaced by a later open; close the adapter directly.
    closeCachedConnection(cached, "workspace");
    _dbCache.delete(key);
  }
}

export function getDbProvider(): ProviderName | null {
  providerLoader.load();
  return providerLoader.getProviderName();
}

export function isDbAvailable(): boolean {
  return currentDb !== null;
}

/**
 * Returns true if openDatabase() has been called at least once this session.
 * Used to distinguish "DB not yet initialized" from "DB genuinely unavailable"
 * so that early callers (e.g. before_agent_start context injection) don't
 * trigger a false degraded-mode warning.
 */
export function wasDbOpenAttempted(): boolean {
  return _dbOpenState.snapshot().attempted;
}

export function getDbStatus(): {
  available: boolean;
  provider: ProviderName | null;
  attempted: boolean;
  lastError: Error | null;
  lastPhase: DbOpenPhase | null;
} {
  providerLoader.load();
  const openState = _dbOpenState.snapshot();
  return {
    available: currentDb !== null,
    provider: providerLoader.getProviderName(),
    attempted: openState.attempted,
    lastError: openState.lastError,
    lastPhase: openState.lastPhase,
  };
}

function runStartupRepair(adapter: DbAdapter, path: string, forceMemoriesFtsRebuild: boolean): void {
  withDatabaseMaintenanceOwner(path, () => {
    _startupRepairBoundaryForTest?.("before-journal", path);
    configureSchemaConnection(adapter, true, path);
    _startupRepairBoundaryForTest?.("after-journal", path);
    prepareStartupMigrationBackup(adapter, path);
    _startupRepairBoundaryForTest?.("after-backup", path);

    function initialize(): void {
      _startupInitializationBoundaryForTest?.(path);
      initSchema(adapter, true, path, false, true, forceMemoriesFtsRebuild);
    }

    try {
      initialize();
    } catch (error) {
      if (!shouldAttemptVacuumRecovery(true, error)) throw error;
      _startupRepairBoundaryForTest?.("before-vacuum", path);
      adapter.exec("VACUUM");
      initialize();
      logWarning("db", "recovered corrupt database via VACUUM");
    }
  });
}

function retainOrCloseFailedOpen(
  adapter: DbAdapter,
  maintenance: DatabaseMaintenanceCleanupState | undefined,
  exclusiveOwnershipHeld: boolean,
  adapterClosed = false,
): void {
  const cleanup: StartupCleanupState = {
    adapter,
    claim: maintenance?.claim,
    projectionRelease: maintenance?.projectionRelease,
    exclusiveOwnershipHeld,
    adapterClosed,
  };
  try {
    cleanupStartupOwnership(cleanup);
  } catch (closeError) {
    quarantineStartupCleanup(cleanup);
    logWarning("db", `close after database open failure failed: ${(closeError as Error).message}`);
  }
}

function openDatabaseInternal(path: string, allowReplacementWrite: boolean, createIfMissing = true): boolean {
  _dbOpenState.markAttempted();
  cleanupPendingDatabaseMaintenance();
  cleanupPendingStartup();
  if (currentDb && currentPath !== path) closeDatabase();
  if (currentDb && currentPath === path) {
    if (allowReplacementWrite && _replacementObservationDatabases.has(currentDb)) {
      closeDatabase();
    } else {
      try {
        assertDatabaseAdapterMatchesPath(currentDb, path);
        if (
          path === ":memory:"
          || _replacementObservationDatabases.has(currentDb)
          || !assessStartupRepair(currentDb).required
        ) {
          return true;
        }
        closeDatabase();
        _dbOpenState.markAttempted();
      } catch {
        closeDatabase();
      }
    }
  }

  // Reset error state only when a new open attempt is actually going to run.
  _dbOpenState.clearError();

  const fileBacked = path !== ":memory:";
  const replacementObservation = fileBacked
    && !allowReplacementWrite
    && databaseReplacementIntentExists(path);
  let rawDb: unknown;
  let openedIdentity: FileIdentity | undefined;
  let adapter: DbAdapter;
  if (replacementObservation) {
    try {
      adapter = openSqliteReadOnly(path, { immutable: true }).db;
      _databaseAdapterFileIdentities.set(adapter, strictFileIdentity(path, "canonical database"));
      _replacementObservationDatabases.add(adapter);
    } catch (error) {
      _dbOpenState.recordError(isSqliteBusyError(error) ? "locked" : "open", error);
      throw error;
    }
  } else {
    try {
      ({ raw: rawDb, identity: openedIdentity } = openCorrelatedRawDatabase(
        path,
        () => providerLoader.openRaw(path, { createIfMissing }),
        createIfMissing,
      ));
    } catch (error) {
      _dbOpenState.recordError(isSqliteBusyError(error) ? "locked" : "open", error);
      throw error;
    }
    if (!rawDb) return false;
    adapter = createFileBoundDatabaseAdapter(rawDb, path, openedIdentity);
  }

  let replacementRecovery = false;
  let maintenanceRecovery = false;
  let startupMaintenance: DatabaseMaintenanceCleanupState | undefined;
  let startupExclusiveOwnershipHeld = false;
  try {
    replacementRecovery = fileBacked && databaseReplacementIntentExists(path);
    maintenanceRecovery = fileBacked && databaseMaintenanceIntentIsActive(path);
    _databaseOpenAfterIntentCheckForTest?.(path);
    if (replacementRecovery || maintenanceRecovery) {
      configureMutationFreeConnection(adapter);
    } else if (!fileBacked) {
      initSchema(adapter, fileBacked, path);
    } else {
      const repair = assessStartupRepair(adapter);
      if (!repair.required) {
        configureMutationFreeConnection(adapter);
      } else {
        startupMaintenance = acquireStartupMaintenance(adapter, path);
        startupExclusiveOwnershipHeld = true;
        runStartupRepair(adapter, path, repair.forceMemoriesFtsRebuild);
      }
    }
  } catch (err) {
    _dbOpenState.recordError(isSqliteBusyError(err) ? "locked" : "initSchema", err);
    if (pendingStartupCleanup?.adapter !== adapter) {
      retainOrCloseFailedOpen(adapter, startupMaintenance, startupExclusiveOwnershipHeld);
    }
    throw err;
  }

  if (!replacementRecovery && !maintenanceRecovery && startupMaintenance !== undefined) {
    try {
      releaseStartupExclusiveOwnership(adapter);
      startupExclusiveOwnershipHeld = false;
      _startupReopenCloseForTest?.(adapter);
      adapter.close();
    } catch (error) {
      _dbOpenState.recordError(isSqliteBusyError(error) ? "locked" : "open", error);
      quarantineStartupCleanup({
        adapter,
        claim: startupMaintenance.claim,
        projectionRelease: startupMaintenance.projectionRelease,
        exclusiveOwnershipHeld: startupExclusiveOwnershipHeld,
        adapterClosed: false,
      });
      throw error;
    }

    let runtimeAdapterOpened = false;
    try {
      ({ raw: rawDb, identity: openedIdentity } = openCorrelatedRawDatabase(
        path,
        () => providerLoader.openRaw(path, { createIfMissing }),
        createIfMissing,
      ));
      if (!rawDb) {
        completeDatabaseMaintenanceCleanup(startupMaintenance);
        startupMaintenance = undefined;
        return false;
      }
      adapter = createFileBoundDatabaseAdapter(rawDb, path, openedIdentity);
      runtimeAdapterOpened = true;
      restoreRuntimeJournalMode(adapter, path);
      configureOpenConnection(adapter, path);
      completeDatabaseMaintenanceCleanup(startupMaintenance);
      startupMaintenance = undefined;
    } catch (error) {
      _dbOpenState.recordError(isSqliteBusyError(error) ? "locked" : "open", error);
      retainOrCloseFailedOpen(adapter, startupMaintenance, false, !runtimeAdapterOpened);
      throw error;
    }
  }

  currentDb = adapter;
  currentPath = path;
  currentPid = process.pid;

  ensureExitHandlerRegistered();

  return true;
}

function openDatabaseWithMode(path: string, createIfMissing: boolean): boolean {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return openDatabaseInternal(path, false, createIfMissing);
    } catch (error) {
      const backoffMs = DB_OPEN_BUSY_BACKOFF_MS[attempt];
      if (!isSqliteBusyError(error) || backoffMs === undefined) throw error;
      Atomics.wait(DB_OPEN_BUSY_SLEEP, 0, 0, backoffMs);
    }
  }
}

export function openDatabase(path: string): boolean {
  return openDatabaseWithMode(path, true);
}

export function openExistingDatabase(path: string): boolean {
  return openDatabaseWithMode(path, false);
}

export function promoteDatabaseForReplacementRecovery(): void {
  if (!currentDb || !currentPath || !_replacementObservationDatabases.has(currentDb)) return;
  const path = currentPath;
  closeDatabase();
  if (!openDatabaseInternal(path, true)) {
    throw new GSDError(GSD_STALE_STATE, "gsd-db: Replacement recovery database did not reopen for explicit restore");
  }
}

function shouldAttemptVacuumRecovery(fileBacked: boolean, err: unknown): boolean {
  return fileBacked && err instanceof Error && err.message.includes("malformed") && !isMigrationBackupError(err);
}

export const _shouldAttemptVacuumRecoveryForTest = shouldAttemptVacuumRecovery;

export function closeDatabase(): void {
  cleanupPendingDatabaseMaintenance();
  cleanupPendingStartup();
  if (currentDb) {
    try {
      currentDb.close();
    } catch (e) {
      logWarning("db", `database close failed: ${(e as Error).message}`);
      throw e;
    }
    // If this connection was workspace-tracked, evict it from the cache so
    // subsequent openDatabaseByWorkspace() calls re-open rather than reactivate
    // a closed adapter.
    if (_currentIdentityKey !== null) {
      _dbCache.delete(_currentIdentityKey);
      _currentIdentityKey = null;
    }
    currentDb = null;
    currentPath = null;
    currentPid = 0;
  }
  // Reset session-scoped state unconditionally so stale error info from a
  // failed open doesn't persist into the next open attempt or status check.
  _dbOpenState.reset();
}

/**
 * Open an isolated database connection that does NOT touch the process-wide
 * `currentDb` singleton. Intended for background observers (e.g. the parallel
 * monitor overlay) that must read a database without displacing an active
 * workflow session connection.
 *
 * The caller MUST call `adapter.close()` when done. Schema migrations are NOT
 * run — the database must already exist and be fully migrated by the primary
 * connection. Returns null if the connection cannot be opened.
 */
export function openIsolatedDatabase(path: string): DbAdapter | null {
  let adapter: DbAdapter | undefined;
  try {
    if (databaseReplacementIntentExists(path)) return null;
    adapter = openSqliteReadOnly(path).db;
    adapter.exec("PRAGMA busy_timeout = 5000");
    const databasePath = realpathSync(path);
    const openedAdapter = adapter;
    let closed = false;
    const tracked: DbAdapter = {
      exec: (sql) => openedAdapter.exec(sql),
      prepare: (sql) => openedAdapter.prepare(sql),
      close() {
        if (closed) return;
        openedAdapter.close();
        closed = true;
        _isolatedDatabases.delete(tracked);
      },
    };
    _isolatedDatabases.set(tracked, databasePath);
    if (databaseReplacementIntentExists(path)) {
      tracked.close();
      return null;
    }
    return tracked;
  } catch {
    try { adapter?.close(); } catch { /* opening already failed */ }
    return null;
  }
}

/** Create a standalone SQLite snapshot that includes committed WAL frames. */
export function snapshotDatabaseFile(sourcePath: string, destinationPath: string): void {
  const stagingPath = `${destinationPath}.snapshot-${randomUUID()}`;
  let source: DbAdapter | undefined;
  try {
    const opened = openCorrelatedRawDatabase(sourcePath, () => providerLoader.openRaw(sourcePath));
    if (!opened.raw) throw new Error("SQLite provider unavailable");
    source = createFileBoundDatabaseAdapter(opened.raw, sourcePath, opened.identity);
    source.prepare("VACUUM INTO ?").run(stagingPath);

    const snapshot = openSqliteReadOnly(stagingPath);
    try {
      if (snapshot.db.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok") {
        throw new Error("SQLite snapshot failed quick_check");
      }
    } finally {
      snapshot.db.close();
    }

    const descriptor = openSync(
      stagingPath,
      process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(stagingPath, destinationPath);
    syncDirectory(dirname(destinationPath));
  } finally {
    try { source?.close(); } finally {
      try { unlinkSync(stagingPath); } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      }
    }
  }
}

/**
 * Re-open the active database connection from disk.
 *
 * Auto-mode can observe artifacts written by a workflow server running in a
 * different process before its long-lived singleton has re-synchronized. The
 * recovery path uses this to force the next state derivation to read from the
 * current on-disk database instead of continuing with a possibly stale handle.
 */
export function refreshOpenDatabaseFromDisk(): boolean {
  if (!currentDb || !currentPath) return false;
  if (currentPath === ":memory:") return false;
  assertDatabaseReplacementFenceAllowsWrite();

  const dbPath = currentPath;
  const identityKey = _currentIdentityKey;

  try {
    closeDatabase();
    const opened = openDatabase(dbPath);
    if (opened && identityKey && currentDb) {
      _dbCache.set(identityKey, { dbPath, db: currentDb });
      _currentIdentityKey = identityKey;
    }
    return opened;
  } catch (e) {
    logWarning("db", `database refresh failed: ${(e as Error).message}`);
    return false;
  }
}

/** Run a full VACUUM — call sparingly (e.g. after milestone completion). */
export function vacuumDatabase(): void {
  if (!currentDb) return;
  runCoordinatedMaintenance((db) => {
    try {
      db.exec('VACUUM');
    } catch (e) { logWarning("db", `VACUUM failed: ${(e as Error).message}`); }
  });
}

/** Flush WAL into gsd.db so `git add .gsd/gsd.db` stages current state — safe while DB is open. */
export function checkpointDatabase(): void {
  if (!currentDb) return;
  runCoordinatedMaintenance((db) => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { logWarning("db", `WAL checkpoint failed: ${(e as Error).message}`); }
  });
}

function runCoordinatedMaintenance(operation: (db: DbAdapter) => void): void {
  if (!currentDb || !currentPath || currentPath === ":memory:") {
    if (currentDb) operation(currentDb);
    return;
  }
  const db = currentDb;
  const path = currentPath;
  if (_transactionRunner.isInTransaction()) {
    // SQLite rejects BEGIN IMMEDIATE inside an open transaction, and neither
    // wal_checkpoint nor VACUUM can run inside one. Defer with a warning
    // instead of failing the caller with a raw nested-transaction error — the
    // outer transaction's own commit path stays authoritative.
    logWarning("db", "coordinated database maintenance skipped inside an open transaction");
    return;
  }
  let transactionOpen = false;
  let maintenance: DatabaseMaintenanceCleanupState | undefined;
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    _maintenanceBeforeLockForTest?.();
    assertDatabaseReplacementFenceAllowsPath(path);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    assertDatabaseReplacementFenceAllowsPath(path);
    maintenance = acquireDatabaseMaintenance(path);
    db.exec("COMMIT");
    transactionOpen = false;
    _maintenanceAfterClaimForTest?.();
    withDatabaseMaintenanceOwner(path, () => operation(db));
  } finally {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* retain maintenance failure */ }
    }
    if (maintenance !== undefined) releaseDatabaseMaintenanceCleanup(maintenance);
  }
}

export async function withDatabaseMaintenanceClaim<T>(operation: () => Promise<T>): Promise<T> {
  if (!currentDb || !currentPath || currentPath === ":memory:") return operation();
  const db = currentDb;
  const path = currentPath;
  let transactionOpen = false;
  let maintenance: DatabaseMaintenanceCleanupState | undefined;
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    _maintenanceBeforeLockForTest?.();
    assertDatabaseReplacementFenceAllowsPath(path);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    assertDatabaseReplacementFenceAllowsPath(path);
    maintenance = acquireDatabaseMaintenance(path);
    db.exec("COMMIT");
    transactionOpen = false;
    _maintenanceAfterClaimForTest?.();
    return await withDatabaseMaintenanceOwner(path, operation);
  } finally {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    if (maintenance !== undefined) releaseDatabaseMaintenanceCleanup(maintenance);
  }
}

const _transactionRunner = createDbTransactionRunner();

function beginWriteTransaction(db: DbAdapter): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    assertDatabaseReplacementFenceAllowsWrite();
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new GSDError(
        GSD_STALE_STATE,
        "gsd-db: Database replacement fence rejected a writer and rollback failed",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

function createTransactionControls(db: DbAdapter) {
  return {
    begin: () => beginWriteTransaction(db),
    beginRead: () => db.exec("BEGIN DEFERRED"),
    beginImmediate: () => beginWriteTransaction(db),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  };
}

/** Run one consistent read snapshot on a caller-owned database connection. */
export function readIndependentDatabaseTransaction<T>(
  db: DbAdapter,
  fn: () => T,
  onRollbackError: (error: Error) => void,
): T {
  return createDbTransactionRunner().readTransaction(
    createTransactionControls(db),
    fn,
    onRollbackError,
  );
}

/**
 * Whether the current call is running inside an active SQLite transaction.
 * Statement-time recovery paths (e.g. VACUUM retry on a malformed memory
 * store) MUST gate on this — SQLite refuses VACUUM inside a transaction
 * and would mask the original error with a secondary "cannot VACUUM" throw.
 */
export function isInTransaction(): boolean {
  return _transactionRunner.isInTransaction();
}

export function transaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  if (!_transactionRunner.isInTransaction()) assertDatabaseReplacementFenceAllowsWrite();
  return _transactionRunner.transaction(createTransactionControls(currentDb), fn);
}

/**
 * Run a BEGIN IMMEDIATE write transaction for operations that need SQLite's
 * reserved writer lock before issuing updates. Re-entrant like transaction():
 * nested calls run inside the outer transaction without a nested BEGIN.
 */
export function immediateTransaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  if (!_transactionRunner.isInTransaction()) assertDatabaseReplacementFenceAllowsWrite();
  return _transactionRunner.immediateTransaction(createTransactionControls(currentDb), fn);
}

/**
 * Wrap a block of reads in a DEFERRED transaction so that all SELECTs observe
 * a consistent snapshot of the DB even if a concurrent writer commits between
 * them. Use this for multi-query read flows (e.g. tool executors that query
 * milestone + slices + counts and want one snapshot). Re-entrant — if already
 * inside a transaction, runs fn() without starting a nested one.
 */
export function readTransaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");

  return _transactionRunner.readTransaction(createTransactionControls(currentDb), fn, (rollbackErr) => {
    // A failed ROLLBACK after a failed read is a split-brain signal —
    // the transaction is in an indeterminate state. Surface it via the
    // logger instead of swallowing it.
    logError("db", "snapshotState ROLLBACK failed", {
      error: rollbackErr.message,
    });
  });
}
export function getDbOwnerPid(): number {
  return currentPid;
}

export function getDbPath(): string | null {
  return currentPath;
}

export function _getAdapter(): DbAdapter | null {
  return currentDb;
}

export function _resetProvider(): void {
  providerLoader.reset();
}

/**
 * The active engine handle, or throw if no database is open. Use in write
 * wrappers — replaces the historical `if (!currentDb) throw ...; currentDb.X`
 * guard with `getDb().X`.
 */
export function getDb(): DbAdapter {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return currentDb;
}

/**
 * The active engine handle or null. Use in read wrappers that no-op (return
 * [] / null) when no database is open.
 */
export function getDbOrNull(): DbAdapter | null {
  return currentDb;
}

export interface DbWritableProbeResult {
  ok: boolean;
  detail?: string;
}

/**
 * Confirm the open handle can actually write, not just that it opened.
 *
 * A schema-current database performs zero writes during open, so a handle that
 * opened successfully but is not writable (read-only file, WAL/SHM permission
 * mismatch, or a stale/moved handle → SQLITE_READONLY_DBMOVED) otherwise passes
 * the open-only availability check and only fails much later at the first real
 * write. The probe forces a genuine page write by re-writing the current
 * `PRAGMA user_version` value back inside an IMMEDIATE transaction: a bare
 * `BEGIN IMMEDIATE; ROLLBACK` is not sufficient because a moved handle does not
 * fail until a page is actually dirtied. The value is unchanged, so the probe
 * is idempotent, and the transaction is rolled back so nothing persists.
 */
export function probeDbWritable(): DbWritableProbeResult {
  const db = currentDb;
  if (!db) return { ok: false, detail: "No database is open." };
  try {
    assertDatabaseReplacementFenceAllowsWrite();
    _probeAfterIntentCheckForTest?.();
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const current = typeof row?.user_version === "number" ? row.user_version : 0;
    beginWriteTransaction(db);
    try {
      db.exec(`PRAGMA user_version = ${current}`);
    } finally {
      db.exec("ROLLBACK");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
