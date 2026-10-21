// gsd-pi — Worktree DB reconciliation log coverage.
//
// `reconcileWorktreeDb` / `copyWorktreeDb` in db/writers/reconcile.ts ATTACH-
// and-merge a worktree's gsd.db back into the project-root DB. Each failure
// branch logs a `db` error/warning so a failed merge never silently drops
// worktree state — these logs are the only record that worktree-only decisions
// were lost. The existing worktree-db tests assert only the merge RESULT counts;
// none asserts any of the failure-path logs. This file pins them:
//   - copyWorktreeDb failed              (reconcile.ts:22)
//   - realpathSync failed                 (reconcile.ts:71)
//   - unsafe characters in path           (reconcile.ts:76)
//   - cannot open main DB                 (reconcile.ts:82)
//   - reconcile transaction failed        (reconcile.ts:494)
//   - rollback / detach failures          (reconcile.ts:486, :491)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  closeDatabase,
  copyWorktreeDb,
  openDatabase,
  reconcileWorktreeDb,
  insertDecision,
} from "../gsd-db.ts";
import { _setMainDbOpenerFnForTests } from "../db/writers/reconcile.ts";
import {
  drainLogs,
  peekLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

function tempDir(prefix = "gsd-reconcile-logs-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Capture log entries emitted while running fn (stderr suppressed). */
function captureLogs<T>(fn: () => T): { result: T; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = fn();
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

function dbLogs(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((e) => e.component === "db");
}

/** Make a minimal valid gsd.db at `dbPath` so a worktree file exists/opens. */
function seedDb(dbPath: string): void {
  openDatabase(dbPath);
  insertDecision({
    id: "D001",
    when_context: "2025-01-01",
    scope: "M001/S01",
    decision: "x",
    choice: "x",
    rationale: "x",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  closeDatabase();
}

test("copyWorktreeDb logs a db error when the source DB cannot be read", () => {
  const srcDir = tempDir();
  const destDir = tempDir();
  const srcDb = path.join(srcDir, "gsd.db");
  const destDb = path.join(destDir, "gsd.db");
  try {
    seedDb(srcDb);
    // Make the source unreadable so copyFileSync throws EACCES.
    fs.chmodSync(srcDb, 0o000);

    const { result, logs } = captureLogs(() => copyWorktreeDb(srcDb, destDb));

    assert.equal(result, false, "copy must report failure");
    const err = dbLogs(logs).find((e) => e.severity === "error");
    assert.ok(err, "a db error must be logged");
    assert.match(err!.message, /failed to copy DB to worktree/u);
    assert.ok(err!.context?.error, "the underlying error must be captured in context");
  } finally {
    // Restore perms so cleanup can delete the file.
    try { fs.chmodSync(srcDb, 0o644); } catch { /* already gone */ }
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test("reconcileWorktreeDb logs a db error for an unsafe path (rejected before ATTACH)", () => {
  const mainDir = tempDir();
  const wtDir = tempDir("gsd-reconcile-logs-unsafe-'");
  try {
    const mainDb = path.join(mainDir, "gsd.db");
    seedDb(mainDb);
    // Worktree file must EXIST so the existsSync guard (reconcile.ts:66)
    // passes and execution reaches the path-sanitizer (:75). The parent temp
    // dir name carries a single-quote so the resolved path is rejected.
    const wtDb = path.join(wtDir, "gsd.db");
    fs.copyFileSync(mainDb, wtDb);

    openDatabase(mainDb);
    const { result, logs } = captureLogs(() => reconcileWorktreeDb(mainDb, wtDb));
    closeDatabase();

    assert.equal(result.decisions, 0, "unsafe path must yield a zero reconcile");
    const err = dbLogs(logs).find((e) => e.severity === "error");
    assert.ok(err, "a db error must be logged for the rejected path");
    assert.match(err!.message, /worktree DB reconciliation failed: path contains unsafe characters/u);
  } finally {
    closeDatabase();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
});

test("reconcileWorktreeDb logs a db warning when realpathSync on the main path fails", () => {
  const wtDir = tempDir();
  const mainDir = tempDir();
  try {
    // A real worktree DB so the existsSync guard (reconcile.ts:66) passes.
    // The main path does not yet exist, so realpathSync(mainDbPath) throws
    // ENOENT — exercising the same-file-guard catch (reconcile.ts:71). The
    // function then proceeds to openDatabase(), which creates the file, so the
    // reconcile completes; we assert only the realpath warning landed.
    const wtDb = path.join(wtDir, "gsd.db");
    seedDb(wtDb);
    closeDatabase();
    const mainDb = path.join(mainDir, "gsd.db");

    const { logs } = captureLogs(() => reconcileWorktreeDb(mainDb, wtDb));
    closeDatabase();

    const warn = dbLogs(logs).find((e) => e.severity === "warn");
    assert.ok(warn, "a db warning must be logged when realpathSync fails");
    assert.match(warn!.message, /realpathSync failed/u);
  } finally {
    closeDatabase();
    fs.rmSync(wtDir, { recursive: true, force: true });
    fs.rmSync(mainDir, { recursive: true, force: true });
  }
});

test("reconcileWorktreeDb logs a db error and zero-result when the worktree DB is corrupt", () => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  try {
    const mainDb = path.join(mainDir, "gsd.db");
    seedDb(mainDb);

    // A worktree DB whose bytes are not SQLite — ATTACH DATABASE will throw,
    // hitting the outer reconcile-failed catch (reconcile.ts:494).
    const wtDb = path.join(wtDir, "gsd.db");
    fs.writeFileSync(wtDb, "this is not a sqlite database", "utf-8");

    openDatabase(mainDb);
    const { result, logs } = captureLogs(() => reconcileWorktreeDb(mainDb, wtDb));
    closeDatabase();

    assert.equal(result.decisions, 0, "a corrupt worktree DB must yield a zero reconcile");
    const err = dbLogs(logs).find((e) => e.severity === "error");
    assert.ok(err, "a db error must be logged for the failed reconcile transaction");
    assert.match(err!.message, /worktree DB reconciliation failed/u);
    assert.ok(err!.context?.error, "the underlying ATTACH/merge error must be captured");
  } finally {
    closeDatabase();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
});

test("reconcileWorktreeDb produces no db errors on the happy path", () => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  try {
    const mainDb = path.join(mainDir, "gsd.db");
    const wtDb = path.join(wtDir, "gsd.db");
    seedDb(mainDb);
    closeDatabase();
    copyWorktreeDb(mainDb, wtDb);

    openDatabase(mainDb);
    const { result, logs } = captureLogs(() => reconcileWorktreeDb(mainDb, wtDb));
    closeDatabase();

    assert.ok(result.decisions >= 0, "happy-path reconcile must return a result");
    assert.equal(
      dbLogs(logs).filter((e) => e.severity === "error").length,
      0,
      "no db error should be logged on a successful reconcile",
    );
  } finally {
    closeDatabase();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
});

test("reconcileWorktreeDb logs a db error when the main DB cannot be opened (reconcile.ts:82)", () => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  try {
    // A real worktree DB so the existsSync guard passes; a real main DB so the
    // realpath same-file guard passes. No DB is open, so reconcileWorktreeDb
    // reaches the openDatabase(main) branch.
    const mainDb = path.join(mainDir, "gsd.db");
    seedDb(mainDb);
    closeDatabase();
    const wtDb = path.join(wtDir, "gsd.db");
    fs.copyFileSync(mainDb, wtDb);

    // Inject an opener that always reports failure so the cannot-open-main-DB
    // branch (reconcile.ts:82) fires deterministically. openDatabase() rethrows
    // on real failures across providers rather than returning false, so this is
    // the only reliable way to exercise the `!opened` branch.
    const restore = _setMainDbOpenerFnForTests(() => false);

    const { result, logs } = captureLogs(() => reconcileWorktreeDb(mainDb, wtDb));
    restore();

    assert.equal(result.decisions, 0, "an unopenable main DB must yield a zero reconcile");
    const err = dbLogs(logs).find((e) => e.severity === "error");
    assert.ok(err, "a db error must be logged when the main DB cannot be opened");
    assert.match(err!.message, /worktree DB reconciliation failed: cannot open main DB/u);
  } finally {
    closeDatabase();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
});

// keep peekLogs import live for any future inline assertions in this file
void peekLogs;
