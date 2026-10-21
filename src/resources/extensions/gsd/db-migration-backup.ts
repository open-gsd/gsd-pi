// Project/App: gsd-pi
// File Purpose: Pre-migration backup helper for GSD database schema upgrades.

import type { DbAdapter } from "./db-adapter.js";

export interface MigrationBackupDeps {
  existsSync(path: string): boolean;
  copyFileSync(src: string, dest: string): void;
  logWarning(scope: string, message: string): void;
  allowMissingSchemaVersion?: boolean;
}

/** Marks pre-migration backup failures so DB-open recovery cannot mask them. */
export class MigrationBackupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MigrationBackupError";
  }
}

/** Returns true for errors raised while checkpointing, copying, or validating a migration backup. */
export function isMigrationBackupError(err: unknown): err is MigrationBackupError {
  return err instanceof MigrationBackupError;
}

/**
 * Creates a same-version backup before file-backed schema migrations.
 *
 * Same-version backups are replaced so they always represent the database
 * being migrated. WAL checkpoint, copy, integrity-check, and schema-version
 * failures are logged and then rethrown before migration DDL runs.
 */
export function backupDatabaseBeforeMigration(
  db: DbAdapter,
  dbPath: string | null,
  currentVersion: number,
  deps: MigrationBackupDeps,
): void {
  if (!dbPath || dbPath === ":memory:" || !deps.existsSync(dbPath)) return;

  try {
    const backupPath = `${dbPath}.backup-v${currentVersion}`;
    checkpointWal(db);
    deps.copyFileSync(dbPath, backupPath);
    verifyBackup(db, backupPath, currentVersion, deps.allowMissingSchemaVersion === true);
  } catch (backupErr) {
    const error = toMigrationBackupError(backupErr);
    deps.logWarning("db", `Pre-migration backup failed: ${error.message}`);
    throw error;
  }
}

function verifyBackup(db: DbAdapter, backupPath: string, currentVersion: number, allowMissingSchemaVersion: boolean): void {
  let attached = false;
  try {
    db.prepare("ATTACH DATABASE ? AS migration_backup").run(backupPath);
    attached = true;
    const check = db.prepare("PRAGMA migration_backup.quick_check").get()?.["quick_check"];
    if (check !== "ok") {
      throw new MigrationBackupError(`backup failed quick_check: ${String(check)}`);
    }
    if (allowMissingSchemaVersion) {
      const metadata = db.prepare(`
        SELECT 1 AS present
        FROM migration_backup.sqlite_master
        WHERE type = 'table' AND name = 'schema_version'
      `).get();
      if (!metadata?.["present"]) return;
      const version = db.prepare(
        "SELECT MAX(version) AS version FROM migration_backup.schema_version",
      ).get()?.["version"];
      if (typeof version !== "number") return;
    }
    const version = Number(
      db.prepare("SELECT MAX(version) AS version FROM migration_backup.schema_version").get()?.["version"],
    );
    if (version !== currentVersion) {
      throw new MigrationBackupError(`backup schema is v${version}, expected v${currentVersion}`);
    }
  } finally {
    if (attached) db.exec("DETACH DATABASE migration_backup");
  }
}

function checkpointWal(db: DbAdapter): void {
  const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (!isCheckpointComplete(row)) {
    const busy = formatCheckpointValue(row, "busy");
    const log = formatCheckpointValue(row, "log");
    const checkpointed = formatCheckpointValue(row, "checkpointed");
    throw new MigrationBackupError(
      `WAL checkpoint incomplete: busy=${busy} log=${log} checkpointed=${checkpointed}`,
    );
  }
}

function isCheckpointComplete(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  const busy = Number(row["busy"]);
  const log = Number(row["log"]);
  const checkpointed = Number(row["checkpointed"]);
  if (!Number.isFinite(busy) || !Number.isFinite(log) || !Number.isFinite(checkpointed)) return false;
  return busy === 0 && log === checkpointed;
}

function formatCheckpointValue(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return value === undefined ? "unknown" : String(value);
}

function toMigrationBackupError(err: unknown): MigrationBackupError {
  if (isMigrationBackupError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MigrationBackupError(message, err);
}
