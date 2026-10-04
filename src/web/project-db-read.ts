import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

/**
 * Open a project's `.gsd/gsd.db` for a read that does not change the project:
 * no migration, no checkout-binding check, and no new file. A database with no
 * `-wal` file was closed cleanly, and it is opened immutable, because a plain
 * read-only open of a WAL-mode database creates `-shm` and `-wal` files. A
 * `-wal` file means that a session has the project open, so a plain read-only
 * open adds nothing and reads the content of that session.
 *
 * Throws when there is no database or no SQLite provider. The caller closes
 * the connection.
 */
export function openProjectDatabaseReadOnly(projectPath: string): DatabaseSync {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const dbPath = join(projectPath, ".gsd", "gsd.db");
  const location = pathToFileURL(dbPath);
  if (!existsSync(`${dbPath}-wal`)) location.searchParams.set("immutable", "1");
  return new DatabaseSync(location, { readOnly: true });
}
