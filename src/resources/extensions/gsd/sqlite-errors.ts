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
