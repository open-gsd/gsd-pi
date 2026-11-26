// Project/App: gsd-pi
// File Purpose: SQLite provider loading and lifecycle helpers for the GSD database facade.

import { closeSync, existsSync, openSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type DbProviderName = "node:sqlite";

export const MIN_SQLITE_NODE_VERSION = "22.19.0";

export interface SqliteProviderDeps {
  tryRequireNodeSqlite(): unknown;
  suppressSqliteWarning(): void;
  nodeVersion: string;
  writeStderr(message: string): void;
}

type RawDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

type NodeSqliteModule = {
  DatabaseSync?: new (path: string | URL, options?: { readOnly?: boolean }) => RawDatabase;
};

export interface SqliteRawOpenOptions {
  createIfMissing?: boolean;
}

function isClosedDatabaseError(error: unknown): boolean {
  return /database (?:is )?not open|database is closed/iu.test(String(error));
}

function versionTuple(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsRequiredSqliteApi(version: string): boolean {
  const actual = versionTuple(version);
  const minimum = versionTuple(MIN_SQLITE_NODE_VERSION)!;
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function suppressSqliteWarning(): void {
  const origEmit = process.emit;
  (process as any).emit = function (event: string, ...args: unknown[]): boolean {
    if (
      event === "warning" &&
      args[0] &&
      typeof args[0] === "object" &&
      "name" in args[0] &&
      (args[0] as { name: string }).name === "ExperimentalWarning" &&
      "message" in args[0] &&
      typeof (args[0] as { message: string }).message === "string" &&
      (args[0] as { message: string }).message.includes("SQLite")
    ) {
      return false;
    }
    return origEmit.apply(process, [event, ...args] as Parameters<typeof process.emit>) as unknown as boolean;
  };
}

function withReadOnlyCloseGuard(writable: RawDatabase, readOnlyGuard: RawDatabase): RawDatabase {
  let writableClosed = false;
  let guardClosed = false;

  function closeHandle(database: RawDatabase): void {
    try {
      database.close();
    } catch (error) {
      try {
        database.prepare("PRAGMA schema_version").get();
      } catch (probeError) {
        if (isClosedDatabaseError(probeError)) return;
      }
      throw error;
    }
  }

  return {
    exec(sql): void {
      writable.exec(sql);
    },
    prepare(sql) {
      return writable.prepare(sql);
    },
    close(): void {
      if (guardClosed) return;
      if (!writableClosed) {
        try {
          readOnlyGuard.prepare("PRAGMA schema_version").get();
        } catch (error) {
          const journalMode = writable.prepare("PRAGMA journal_mode").get()?.["journal_mode"];
          if (journalMode !== "delete") throw error;
        }
        closeHandle(writable);
        writableClosed = true;
      }
      closeHandle(readOnlyGuard);
      guardClosed = true;
    },
  };
}

export class SqliteProviderLoader {
  private providerModule: NodeSqliteModule | null = null;
  private loadAttempted = false;
  private readonly deps: SqliteProviderDeps;

  constructor(deps: SqliteProviderDeps) {
    this.deps = deps;
  }

  load(): void {
    if (this.loadAttempted) return;
    this.loadAttempted = true;

    const supportedRuntime = supportsRequiredSqliteApi(this.deps.nodeVersion);
    if (supportedRuntime) {
      try {
        this.deps.suppressSqliteWarning();
        const mod = this.deps.tryRequireNodeSqlite() as NodeSqliteModule;
        if (mod.DatabaseSync) {
          this.providerModule = mod;
          return;
        }
      } catch {
        this.providerModule = null;
      }
    }

    const versionHint = supportedRuntime
      ? " Use a Node build with node:sqlite enabled."
      : ` GSD requires Node >= ${MIN_SQLITE_NODE_VERSION} for node:sqlite (current: v${this.deps.nodeVersion}). Upgrade Node to fix this.`;
    this.deps.writeStderr(`gsd-db: No SQLite provider available.${versionHint}\n`);
  }

  getProviderName(): DbProviderName | null {
    return this.providerModule ? "node:sqlite" : null;
  }

  openRaw(path: string, options: SqliteRawOpenOptions = {}): unknown {
    this.load();
    const DatabaseSync = this.providerModule?.DatabaseSync;
    if (!DatabaseSync) return null;
    if (path === ":memory:") return new DatabaseSync(path);

    const createIfMissing = options.createIfMissing !== false;
    if (createIfMissing) {
      closeSync(openSync(path, "a"));
    } else if (!existsSync(path)) {
      // DatabaseSync passes SQLITE_OPEN_CREATE, so a no-create open of a path
      // deleted at the open boundary would recreate an empty DB on Windows
      // (#2158). Refuse explicitly before any handle exists.
      throw Object.assign(
        new Error(`unable to open database file: ${path}`),
        { code: "SQLITE_CANTOPEN", errcode: 14 },
      );
    }
    const readOnlyGuard = new DatabaseSync(path, { readOnly: true });
    try {
      let writablePath: string | URL = path;
      if (!createIfMissing) {
        writablePath = pathToFileURL(path);
        writablePath.searchParams.set("mode", "rw");
      }
      return withReadOnlyCloseGuard(new DatabaseSync(writablePath), readOnlyGuard);
    } catch (error) {
      readOnlyGuard.close();
      throw error;
    }
  }

  reset(): void {
    this.loadAttempted = false;
    this.providerModule = null;
  }
}

export function createSqliteProviderLoader(deps: SqliteProviderDeps): SqliteProviderLoader {
  return new SqliteProviderLoader(deps);
}
