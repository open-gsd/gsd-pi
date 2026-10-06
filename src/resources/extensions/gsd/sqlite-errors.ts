// Project/App: gsd-pi
// File Purpose: Shared SQLite error classification used by open and write paths.

export function isSqliteBusyError(error: unknown): boolean {
  const record = error as { code?: unknown; errcode?: unknown; message?: unknown };
  const code = String(record?.code ?? "");
  const message = String(record?.message ?? error);
  return record?.errcode === 5
    || code.includes("SQLITE_BUSY")
    || /SQLITE_BUSY|database is locked/i.test(message);
}

/** SQLITE_CORRUPT (11) or SQLITE_NOTADB (26): the bytes are proven not to be a usable database. */
export function isSqliteCorruptError(error: unknown): boolean {
  const record = error as { errcode?: unknown; message?: unknown };
  const primary = typeof record?.errcode === "number" ? record.errcode & 0xff : null;
  return primary === 11
    || primary === 26
    || /malformed|file is not a database/i.test(String(record?.message ?? error));
}
