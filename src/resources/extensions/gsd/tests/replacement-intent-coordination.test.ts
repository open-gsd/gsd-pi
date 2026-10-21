import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setDatabaseOpenAfterIntentCheckForTest,
  _setStartupInitializationBoundaryForTest,
  _setStartupRepairBoundaryForTest,
  _setStartupReopenCloseForTest,
  _setStartupExclusiveReleaseForTest,
  _setStartupSchemaDetectionForTest,
  _setMaintenanceLockHooksForTest,
  _setDatabaseOpenBeforeRawForTest,
  _setDatabaseOpenAfterRawForTest,
  _setProbeAfterIntentCheckForTest,
  withDatabaseMaintenanceClaim,
  openIsolatedDatabase,
  probeDbWritable,
  openDatabaseByWorkspace,
} from "../db/engine.ts";
import { _setSqliteReadOnlyOpenBoundaryForTest } from "../sqlite-readonly.ts";
import {
  _setProjectionClaimReleaseBoundaryForTest,
  _setProjectionMutationBeforeClaimForTest,
  claimProjectionMaintenance,
  databaseMaintenanceIntentPath,
  withProjectionMutationSync,
} from "../database-maintenance-fence.ts";
import { createWorkspace } from "../workspace.ts";
import {
  _setBeforeMilestoneStatusObservationWriteForTest,
  beginMilestoneStatusObservationTurn,
} from "../milestone-status-observation-context.ts";

import type { DbAdapter } from "../db-adapter.ts";
import {
  _getAdapter,
  checkpointDatabase,
  closeDatabase,
  copyWorktreeDb,
  getDatabaseReplacementPaths,
  getDecisionById,
  insertDecision,
  insertMilestone,
  insertSlice,
  openDatabase,
  reconcileWorktreeDb,
  vacuumDatabase,
} from "../gsd-db.ts";
import {
  getAutoWorker,
  heartbeatAutoWorker,
  registerAutoWorker,
} from "../db/auto-workers.ts";
import {
  claimNextCommand,
  completeCommand,
  enqueueCommand,
  getCommand,
} from "../db/command-queue.ts";
import {
  claimMilestoneLease,
  getMilestoneLease,
  refreshMilestoneLease,
} from "../db/milestone-leases.ts";
import {
  deleteRuntimeKv,
  getRuntimeKv,
  setRuntimeKv,
} from "../db/runtime-kv.ts";
import {
  getLatestForUnit,
  markCanceled,
  markPaused,
  markRunning,
  recordDispatchClaim,
} from "../db/unit-dispatches.ts";

function makeDatabasePath(prefix: string): { base: string; databasePath: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(base, ".gsd", "gsd.db");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return { base, databasePath };
}

function createReplacementIntent(databasePath: string): void {
  const paths = getDatabaseReplacementPaths(databasePath);
  mkdirSync(paths.recoveryDirectory, { recursive: true });
  writeFileSync(paths.activeIntentPath, "{}", { mode: 0o600 });
}

function cleanup(...bases: string[]): void {
  _setDatabaseOpenAfterIntentCheckForTest(null);
  _setStartupInitializationBoundaryForTest(null);
  _setStartupRepairBoundaryForTest(null);
  _setStartupReopenCloseForTest(null);
  _setStartupExclusiveReleaseForTest(null);
  _setStartupSchemaDetectionForTest(null);
  _setMaintenanceLockHooksForTest(null);
  _setProjectionClaimReleaseBoundaryForTest(null);
  _setDatabaseOpenBeforeRawForTest(null);
  _setDatabaseOpenAfterRawForTest(null);
  _setSqliteReadOnlyOpenBoundaryForTest(null);
  _setProbeAfterIntentCheckForTest(null);
  _setBeforeMilestoneStatusObservationWriteForTest(null);
  try {
    closeDatabase();
  } catch {
    // best effort
  }
  for (const base of bases) {
    rmSync(base, { recursive: true, force: true });
  }
}

test("startup rechecks replacement intent after acquiring its writer lock", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-startup-race-");
  t.after(() => cleanup(base));
  const seed = new DatabaseSync(databasePath);
  seed.exec("PRAGMA journal_mode=DELETE; CREATE TABLE startup_sentinel (value TEXT NOT NULL)");
  seed.close();

  _setDatabaseOpenAfterIntentCheckForTest(() => createReplacementIntent(databasePath));
  assert.throws(
    () => openDatabase(databasePath),
    /Database writes are fenced while replacement intent exists/,
  );

  const observed = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(observed.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "delete");
  assert.equal(observed.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'schema_version'
  `).get()?.["count"], 0);
  observed.close();
});

test("startup retains its SQLite writer lock through initialization", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-exclusive-init-");
  t.after(() => cleanup(base));
  const seed = new DatabaseSync(databasePath);
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE startup_sentinel (value TEXT NOT NULL)");
  seed.close();

  let competingWriterBlocked = false;
  _setStartupInitializationBoundaryForTest(() => {
    const competitor = new DatabaseSync(databasePath);
    try {
      competitor.exec("PRAGMA busy_timeout=0");
      assert.throws(() => competitor.exec("BEGIN IMMEDIATE"), /database is locked/iu);
      competingWriterBlocked = true;
    } finally {
      competitor.close();
    }
  });

  assert.equal(openDatabase(databasePath), true);
  assert.equal(competingWriterBlocked, true);
});

test("startup retains SQLite ownership through journal and backup preparation", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-exclusive-preparation-");
  t.after(() => cleanup(base));
  const seed = new DatabaseSync(databasePath);
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE startup_sentinel (value TEXT NOT NULL)");
  seed.close();

  const observed: string[] = [];
  _setStartupRepairBoundaryForTest((point) => {
    if (point !== "before-journal" && point !== "after-backup") return;
    const competitor = new DatabaseSync(databasePath);
    try {
      competitor.exec("PRAGMA busy_timeout=0");
      assert.throws(() => competitor.exec("BEGIN IMMEDIATE"), /database is locked/iu);
      observed.push(point);
    } finally {
      competitor.close();
    }
  });

  assert.equal(openDatabase(databasePath), true);
  assert.deepEqual(observed, ["before-journal", "after-backup"]);
});

test("startup retains SQLite ownership through VACUUM recovery", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-exclusive-vacuum-");
  t.after(() => cleanup(base));
  const seed = new DatabaseSync(databasePath);
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE startup_sentinel (value TEXT NOT NULL)");
  seed.close();
  let injectMalformed = true;
  let vacuumBlockedCompetitor = false;
  _setStartupInitializationBoundaryForTest(() => {
    if (!injectMalformed) return;
    injectMalformed = false;
    throw new Error("database disk image is malformed");
  });
  _setStartupRepairBoundaryForTest((point) => {
    if (point !== "before-vacuum") return;
    const competitor = new DatabaseSync(databasePath);
    try {
      competitor.exec("PRAGMA busy_timeout=0");
      assert.throws(() => competitor.exec("BEGIN IMMEDIATE"), /database is locked/iu);
      vacuumBlockedCompetitor = true;
    } finally {
      competitor.close();
    }
  });

  assert.equal(openDatabase(databasePath), true);
  assert.equal(vacuumBlockedCompetitor, true);
});

test("schema-current startup skips maintenance and persistent pragmas", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-current-readonly-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  closeDatabase();
  const external = new DatabaseSync(databasePath);
  external.exec("PRAGMA journal_mode=DELETE");
  external.close();
  let maintenancePublished = false;
  _setMaintenanceLockHooksForTest({
    claimBoundary() {
      maintenancePublished = true;
    },
  });

  assert.equal(openDatabase(databasePath), true);
  assert.equal(_getAdapter()!.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "delete");
  assert.equal(maintenancePublished, false);
});

test("startup retains a live initialization adapter when reopen close fails", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-close-retained-");
  t.after(() => cleanup(base));
  let failedAdapter: DbAdapter | undefined;
  let originalClose: (() => void) | undefined;
  _setStartupReopenCloseForTest((adapter) => {
    failedAdapter = adapter;
    originalClose = adapter.close.bind(adapter);
    adapter.close = () => {
      throw new Error("startup close failed before closure");
    };
    _setStartupReopenCloseForTest(null);
  });

  try {
    assert.throws(() => openDatabase(databasePath), /startup close failed before closure/);
    assert.equal(_getAdapter(), null);
    assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), true);
  } finally {
    if (failedAdapter !== undefined && originalClose !== undefined) failedAdapter.close = originalClose;
  }
  assert.equal(openDatabase(databasePath), true);
  assert.notEqual(_getAdapter(), failedAdapter);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
});

test("schema-current startup remains mutation-free while another writer holds the lock", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-startup-contention-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  closeDatabase();

  const blocker = new DatabaseSync(databasePath);
  let lockHeld = true;
  blocker.exec("BEGIN IMMEDIATE");
  t.after(() => {
    if (lockHeld) blocker.exec("ROLLBACK");
    blocker.close();
  });

  assert.equal(openDatabase(databasePath), true);
  assert.equal(_getAdapter()!.prepare("SELECT 1 AS value").get()?.["value"], 1);
  blocker.exec("ROLLBACK");
  lockHeld = false;
});

test("startup fails closed while schema state is unreadable", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-schema-unreadable-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  closeDatabase();

  _setStartupSchemaDetectionForTest(() => {
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    throw error;
  });

  assert.throws(() => openDatabase(databasePath), /database is locked/iu);
  assert.equal(_getAdapter(), null);

  _setStartupSchemaDetectionForTest(null);
  assert.equal(openDatabase(databasePath), true);
});

test("startup cleanup retries a failed exclusive release before reopening", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-release-retry-");
  t.after(() => cleanup(base));
  let releaseAttempts = 0;
  _setStartupExclusiveReleaseForTest(() => {
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw new Error("startup exclusive release failed");
  });

  assert.throws(() => openDatabase(databasePath), /startup exclusive release failed/);
  assert.equal(_getAdapter(), null);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), true);

  assert.equal(openDatabase(databasePath), true);
  assert.equal(releaseAttempts, 2);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
});

test("startup cleanup tracks exclusive ownership without a maintenance claim", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-release-without-claim-");
  t.after(() => cleanup(base));
  let releaseAttempts = 0;
  _setStartupExclusiveReleaseForTest(() => {
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw new Error("startup exclusive release failed");
  });
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point === "after-maintenance-claim-write") throw new Error("maintenance claim failed");
    },
  });

  assert.throws(() => openDatabase(databasePath), /maintenance claim failed/);
  assert.equal(_getAdapter(), null);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);

  _setMaintenanceLockHooksForTest(null);
  assert.equal(openDatabase(databasePath), true);
  assert.equal(releaseAttempts, 3);
});

test("startup cleanup retries after maintenance intent unlink succeeds", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-intent-release-retry-");
  t.after(() => cleanup(base));
  let faultInjected = false;
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point !== "after-maintenance-intent-unlink" || faultInjected) return;
      faultInjected = true;
      throw new Error("maintenance intent durability failed");
    },
  });

  assert.throws(() => openDatabase(databasePath), /maintenance intent durability failed/);
  assert.equal(_getAdapter(), null);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);

  assert.equal(openDatabase(databasePath), true);
  assert.ok(_getAdapter());
});

test("startup cleanup retains an interrupted failed-acquisition release", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-startup-acquisition-release-retry-");
  t.after(() => cleanup(base));
  let claimFailureInjected = false;
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point !== "after-maintenance-claim-write" || claimFailureInjected) return;
      claimFailureInjected = true;
      throw new Error("maintenance acquisition failed");
    },
  });
  let releaseFailures = 0;
  _setProjectionClaimReleaseBoundaryForTest((point) => {
    if (point === "after-link" && releaseFailures === 0) {
      releaseFailures++;
      throw new Error("projection release link failed");
    }
    if (point === "after-primary-unlink" && releaseFailures === 1) {
      releaseFailures++;
      throw new Error("projection release unlink failed");
    }
  });

  assert.throws(() => openDatabase(databasePath), /maintenance acquisition failed/);
  assert.equal(_getAdapter(), null);

  assert.equal(openDatabase(databasePath), true);
  assert.equal(releaseFailures, 2);
  assert.equal(existsSync(`${databasePath}.projection.lock`), false);
  assert.equal(existsSync(`${databasePath}.projection.lock.transition`), false);
});

test("checkpoint and VACUUM acquire and release coordinated maintenance", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-coordinated-maintenance-callers-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  let publications = 0;
  let releases = 0;
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point === "after-maintenance-claim-publish") publications++;
      if (point === "after-maintenance-projection-release") releases++;
    },
  });

  checkpointDatabase();
  vacuumDatabase();

  assert.equal(publications, 2);
  assert.equal(releases, 2);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
  assert.equal(existsSync(`${databasePath}.projection.lock`), false);
});

test("checkpoint and VACUUM retry interrupted release cleanup", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-coordinated-maintenance-release-retry-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);

  for (const [name, operation] of [
    ["checkpoint", checkpointDatabase],
    ["VACUUM", vacuumDatabase],
  ] as const) {
    let releaseInterrupted = false;
    _setMaintenanceLockHooksForTest({
      claimBoundary(point) {
        if (point !== "after-maintenance-intent-unlink" || releaseInterrupted) return;
        releaseInterrupted = true;
        throw new Error(`${name} maintenance release interrupted`);
      },
    });

    assert.throws(operation, new RegExp(`${name} maintenance release interrupted`, "u"));
    assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
    assert.equal(existsSync(`${databasePath}.projection.lock`), true);

    assert.doesNotThrow(operation);
    assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
    assert.equal(existsSync(`${databasePath}.projection.lock`), false);
  }
});

test("public maintenance acquires and releases coordinated ownership", async (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-public-maintenance-caller-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  let operated = false;

  await withDatabaseMaintenanceClaim(async () => {
    operated = true;
  });

  assert.equal(operated, true);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
  assert.equal(existsSync(`${databasePath}.projection.lock`), false);
});

test("projection mutations recheck maintenance fences after acquiring the claim", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-projection-post-claim-fence-");
  const marker = databaseMaintenanceIntentPath(databasePath);
  t.after(() => {
    _setProjectionMutationBeforeClaimForTest(null);
    cleanup(base);
  });
  _setProjectionMutationBeforeClaimForTest(() => writeFileSync(marker, "{}"));
  let mutationRan = false;

  assert.throws(
    () => withProjectionMutationSync(join(base, ".gsd", "projection.md"), () => {
      mutationRan = true;
    }),
    /maintenance intent/,
  );
  assert.equal(mutationRan, false);
});

test("post-publication acquisition cleanup retries intent and projection release", async (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-maintenance-publish-cleanup-retry-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  let publicationFailed = false;
  let cleanupFailures = 0;
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point === "after-maintenance-claim-publish" && !publicationFailed) {
        publicationFailed = true;
        throw new Error("maintenance publication failed");
      }
      if (point === "before-maintenance-intent-unlink" && cleanupFailures < 2) {
        cleanupFailures++;
        throw new Error("maintenance intent cleanup failed");
      }
    },
  });

  await assert.rejects(
    withDatabaseMaintenanceClaim(async () => undefined),
    /maintenance publication failed/,
  );
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), true);
  assert.equal(existsSync(`${databasePath}.projection.lock`), true);

  let retried = false;
  await withDatabaseMaintenanceClaim(async () => {
    retried = true;
  });

  assert.equal(retried, true);
  assert.equal(existsSync(databaseMaintenanceIntentPath(databasePath)), false);
  assert.equal(existsSync(`${databasePath}.projection.lock`), false);
});

test("projection maintenance release resumes after primary unlink", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-projection-release-retry-");
  t.after(() => cleanup(base));
  const release = claimProjectionMaintenance(databasePath);
  let faultInjected = false;
  _setProjectionClaimReleaseBoundaryForTest((point) => {
    if (point !== "after-primary-unlink" || faultInjected) return;
    faultInjected = true;
    throw new Error("projection release interrupted");
  });

  assert.throws(release, /projection release interrupted/);
  release();

  assert.equal(existsSync(`${databasePath}.projection.lock`), false);
  assert.equal(existsSync(`${databasePath}.projection.lock.transition`), false);
  const releaseAgain = claimProjectionMaintenance(databasePath);
  releaseAgain();
});

test("projection maintenance stays active while release is interrupted", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-projection-release-active-");
  t.after(() => cleanup(base));
  const release = claimProjectionMaintenance(databasePath);
  let faultInjected = false;
  _setProjectionClaimReleaseBoundaryForTest((point) => {
    if (point !== "after-link" || faultInjected) return;
    faultInjected = true;
    throw new Error("projection release interrupted before durability");
  });

  assert.throws(release, /projection release interrupted before durability/);
  let mutationRan = false;
  let mutationError: unknown;
  try {
    withProjectionMutationSync(join(base, ".gsd", "projection.md"), () => {
      mutationRan = true;
    });
  } catch (error) {
    mutationError = error;
  }
  try {
    release();
  } catch {}

  assert.match(String(mutationError), /active maintenance|fenced/);
  assert.equal(mutationRan, false);
});

test("projection maintenance cannot be reacquired while release is interrupted", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-projection-release-reacquire-");
  t.after(() => cleanup(base));
  const release = claimProjectionMaintenance(databasePath);
  let faultInjected = false;
  _setProjectionClaimReleaseBoundaryForTest((point) => {
    if (point !== "after-link" || faultInjected) return;
    faultInjected = true;
    throw new Error("projection release interrupted before reacquire");
  });

  assert.throws(release, /projection release interrupted before reacquire/);
  let competingRelease: (() => void) | undefined;
  let reacquireError: unknown;
  try {
    competingRelease = claimProjectionMaintenance(databasePath);
  } catch (error) {
    reacquireError = error;
  }
  competingRelease?.();
  try {
    release();
  } catch {}

  assert.match(String(reacquireError), /active maintenance|fenced/);
});

test("engine replacement paths fence the matching projection mutation", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-path-contract-");
  t.after(() => cleanup(base));
  const paths = getDatabaseReplacementPaths(databasePath);
  mkdirSync(paths.recoveryDirectory, { recursive: true });
  writeFileSync(paths.activeIntentPath, "{}", { mode: 0o600 });
  let mutationRan = false;

  assert.throws(
    () => withProjectionMutationSync(join(base, ".gsd", "projection.md"), () => {
      mutationRan = true;
    }),
    new RegExp(paths.activeIntentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(mutationRan, false);
});

test("workspace restore preserves quarantined startup cleanup for retry", (t) => {
  const first = makeDatabasePath("gsd-startup-workspace-a-");
  const second = makeDatabasePath("gsd-startup-workspace-b-");
  t.after(() => cleanup(first.base, second.base));
  const workspaceA = createWorkspace(first.base);
  const workspaceB = createWorkspace(second.base);
  assert.equal(openDatabaseByWorkspace(workspaceA), true);
  const adapterA = _getAdapter();
  let failedAdapter: DbAdapter | undefined;
  let originalClose: (() => void) | undefined;
  _setStartupReopenCloseForTest((adapter) => {
    failedAdapter = adapter;
    originalClose = adapter.close.bind(adapter);
    adapter.close = () => { throw new Error("workspace startup close failed"); };
    _setStartupReopenCloseForTest(null);
  });

  try {
    assert.throws(() => openDatabaseByWorkspace(workspaceB), /workspace startup close failed/);
    assert.equal(_getAdapter(), adapterA);
    assert.equal(existsSync(databaseMaintenanceIntentPath(second.databasePath)), true);
  } finally {
    if (failedAdapter !== undefined && originalClose !== undefined) failedAdapter.close = originalClose;
  }
  assert.equal(openDatabaseByWorkspace(workspaceB), true);
  assert.notEqual(_getAdapter(), failedAdapter);
  assert.equal(existsSync(databaseMaintenanceIntentPath(second.databasePath)), false);
});

test("writability probe rechecks replacement intent after acquiring its writer lock", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-probe-race-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);

  _setProbeAfterIntentCheckForTest(() => createReplacementIntent(databasePath));
  const result = probeDbWritable();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /Database writes are fenced while replacement intent exists/);
});

test("isolated observation handles reject writes", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-read-only-observer-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  const observer = openIsolatedDatabase(databasePath);
  assert.ok(observer);
  t.after(() => observer.close());

  assert.equal(observer.prepare("PRAGMA query_only").get()?.["query_only"], 1);
  assert.throws(() => observer.prepare(`
    INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
    VALUES ('global', '', 'isolated-write', '{}', '2026-07-18T00:00:00.000Z')
  `).run(), /read.?only|readonly/iu);
  assert.equal(
    _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM runtime_kv WHERE key = 'isolated-write'").get()?.["count"],
    0,
  );
});

test("isolated observation handles fail closed after canonical inode replacement", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-isolated-inode-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  const observer = openIsolatedDatabase(databasePath);
  assert.ok(observer);
  t.after(() => observer.close());
  closeDatabase();

  const replacementPath = join(base, ".gsd", "replacement.db");
  const replacement = new DatabaseSync(replacementPath);
  replacement.exec("CREATE TABLE replacement_sentinel (value TEXT NOT NULL)");
  replacement.close();
  renameSync(databasePath, join(base, ".gsd", "detached.db"));
  renameSync(replacementPath, databasePath);

  assert.throws(() => observer.prepare("SELECT 1 AS value").get(), /detached from its path/);
});

test("database open rejects a path replacement raced after raw open", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-open-inode-");
  t.after(() => cleanup(base));
  const seed = new DatabaseSync(databasePath);
  seed.exec("CREATE TABLE original_sentinel (value TEXT NOT NULL)");
  seed.close();
  const replacementPath = join(base, ".gsd", "replacement.db");
  const replacement = new DatabaseSync(replacementPath);
  replacement.exec("CREATE TABLE replacement_sentinel (value TEXT NOT NULL)");
  replacement.close();

  _setDatabaseOpenAfterRawForTest(() => {
    renameSync(databasePath, join(base, ".gsd", "detached.db"));
    renameSync(replacementPath, databasePath);
  });

  assert.throws(() => openDatabase(databasePath), /Database path changed while its handle opened/);
});

test("database open rejects an ABA path swap around raw open", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-open-aba-");
  t.after(() => cleanup(base));
  const original = new DatabaseSync(databasePath);
  original.exec("CREATE TABLE original_sentinel (value TEXT NOT NULL)");
  original.close();
  const replacementPath = join(base, ".gsd", "replacement.db");
  const replacement = new DatabaseSync(replacementPath);
  replacement.exec("CREATE TABLE replacement_sentinel (value TEXT NOT NULL)");
  replacement.close();
  const heldOriginal = join(base, ".gsd", "held-original.db");
  const heldReplacement = join(base, ".gsd", "held-replacement.db");

  _setDatabaseOpenBeforeRawForTest(() => {
    renameSync(databasePath, heldOriginal);
    renameSync(replacementPath, databasePath);
  });
  _setDatabaseOpenAfterRawForTest(() => {
    renameSync(databasePath, heldReplacement);
    renameSync(heldOriginal, databasePath);
  });

  assert.throws(() => openDatabase(databasePath), /changed while its handle opened/);
});

test("isolated database open rejects an ABA path swap without filesystem proof artifacts", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-isolated-aba-");
  t.after(() => cleanup(base));
  const original = new DatabaseSync(databasePath);
  original.exec("CREATE TABLE original_sentinel (value TEXT NOT NULL)");
  original.close();
  const replacementPath = join(base, ".gsd", "replacement.db");
  const replacement = new DatabaseSync(replacementPath);
  replacement.exec("CREATE TABLE replacement_sentinel (value TEXT NOT NULL)");
  replacement.close();
  const heldOriginal = join(base, ".gsd", "held-original.db");
  const heldReplacement = join(base, ".gsd", "held-replacement.db");

  _setSqliteReadOnlyOpenBoundaryForTest({
    beforeRaw() {
      renameSync(databasePath, heldOriginal);
      renameSync(replacementPath, databasePath);
    },
    afterRaw() {
      renameSync(databasePath, heldReplacement);
      renameSync(heldOriginal, databasePath);
    },
  });

  assert.equal(openIsolatedDatabase(databasePath), null);
  assert.equal(readdirSync(join(base, ".gsd")).some((entry) => entry.startsWith(".sqlite-open-proof-")), false);
});

test("isolated database inspection does not mutate read-only assessed storage", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-isolated-read-only-");
  t.after(() => {
    chmodSync(join(base, ".gsd"), 0o700);
    chmodSync(databasePath, 0o600);
    cleanup(base);
  });
  const seed = new DatabaseSync(databasePath);
  seed.exec("CREATE TABLE original_sentinel (value TEXT NOT NULL)");
  seed.close();
  const before = readdirSync(join(base, ".gsd")).sort();
  chmodSync(databasePath, 0o400);
  chmodSync(join(base, ".gsd"), 0o500);

  const observer = openIsolatedDatabase(databasePath);
  assert.ok(observer);
  assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM original_sentinel").get()?.["count"], 0);
  assert.deepEqual(readdirSync(join(base, ".gsd")).sort(), before);
  observer.close();
  assert.deepEqual(readdirSync(join(base, ".gsd")).sort(), before);
});

test("read-only opener releases identity capture when provider setup throws", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-read-only-release-");
  let releases = 0;
  t.after(() => {
    _setSqliteReadOnlyOpenBoundaryForTest(null);
    cleanup(base);
  });
  const seed = new DatabaseSync(databasePath);
  seed.exec("CREATE TABLE original_sentinel (value TEXT NOT NULL)");
  seed.close();
  _setSqliteReadOnlyOpenBoundaryForTest({
    beforeRaw() {
      throw new Error("simulated provider constructor failure");
    },
    afterRelease() {
      releases++;
    },
  } as Parameters<typeof _setSqliteReadOnlyOpenBoundaryForTest>[0]);

  assert.equal(openIsolatedDatabase(databasePath), null);
  assert.equal(releases, 1);
});

test("Windows ordinary database correlation falls back while exact inspection stays unavailable", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-windows-open-");
  t.after(() => cleanup(base));
  const engineUrl = new URL("../db/engine.ts", import.meta.url).href;
  const loaderPath = new URL("./resolve-ts.mjs", import.meta.url).pathname;
  const script = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(import.meta.url);
    const fs = require("node:fs");
    const original = fs.readdirSync;
    fs.readdirSync = (path, ...args) => {
      if (path === "/proc/self/fd" || path === "/dev/fd") {
        const error = new Error("descriptor filesystem unavailable");
        error.code = "ENOENT";
        throw error;
      }
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: "win32" });
    const sqlite = await import(new URL("../sqlite-readonly.ts", ${JSON.stringify(engineUrl)}));
    const { DatabaseSync } = await import("node:sqlite");
    const capture = sqlite.captureSqliteOpenIdentity(process.argv[1]);
    const raw = new DatabaseSync(process.argv[1]);
    const identity = sqlite.correlateSqliteOpenIdentity(process.argv[1], capture, raw);
    raw.close();
    identity.release?.();
    let exactUnavailable = false;
    try {
      sqlite.captureSqliteOpenIdentity(process.argv[1], false, true);
    } catch (error) {
      exactUnavailable = /native|identity|available/i.test(String(error));
    }
    if (!exactUnavailable) process.exitCode = 2;
  `;
  const result = spawnSync(process.execPath, [
    "--import", loaderPath,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval", script,
    databasePath,
  ], { encoding: "utf8", env: { ...process.env, GSD_NATIVE_DISABLE: "1" } });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("workspace cache retains ownership when an out-of-band inode swap prevents guarded close", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-cache-inode-");
  t.after(() => cleanup(base));
  const engineUrl = new URL("../db/engine.ts", import.meta.url).href;
  const workspaceUrl = new URL("../workspace.ts", import.meta.url).href;
  const loaderPath = new URL("./resolve-ts.mjs", import.meta.url).pathname;
  const script = `
    import assert from "node:assert/strict";
    import { existsSync, renameSync } from "node:fs";
    import { join } from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const engine = await import(${JSON.stringify(engineUrl)});
    const { createWorkspace } = await import(${JSON.stringify(workspaceUrl)});
    const base = process.argv[1];
    const databasePath = join(base, ".gsd", "gsd.db");
    const workspace = createWorkspace(base);
    assert.equal(engine.openDatabaseByWorkspace(workspace), true);
    engine._getAdapter().exec("CREATE TABLE inode_sentinel (value TEXT NOT NULL); INSERT INTO inode_sentinel VALUES ('old')");
    const replacementPath = join(base, ".gsd", "replacement.db");
    const replacement = new DatabaseSync(replacementPath);
    replacement.exec("CREATE TABLE inode_sentinel (value TEXT NOT NULL); INSERT INTO inode_sentinel VALUES ('new')");
    replacement.close();
    renameSync(databasePath, join(base, ".gsd", "detached-old.db"));
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = databasePath + suffix;
      if (existsSync(sidecar)) renameSync(sidecar, join(base, ".gsd", "detached-old.db" + suffix));
    }
    renameSync(replacementPath, databasePath);
    const retained = engine._getAdapter();
    assert.throws(() => engine.openDatabaseByWorkspace(workspace), /disk I\\/O error/iu);
    assert.equal(engine._getAdapter(), retained);
  `;
  const result = spawnSync(process.execPath, [
    "--import", loaderPath,
    "--experimental-strip-types",
    "--input-type=module",
    "--eval", script,
    base,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("observation soft-state writes use the fenced canonical writer", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-observation-writer-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  let injected = false;
  _setBeforeMilestoneStatusObservationWriteForTest(() => {
    if (injected) return;
    injected = true;
    createReplacementIntent(databasePath);
  });

  assert.equal(beginMilestoneStatusObservationTurn(base, {
    mode: "guided",
    sourceRevision: "sha256:startup-race",
  }, { token: "fence" }), null);
  assert.equal(injected, true);
  assert.equal(
    _getAdapter()!.prepare(`
      SELECT COUNT(*) AS count FROM runtime_kv
      WHERE key = 'milestone-status-observation-turn:fence'
    `).get()?.["count"],
    0,
  );
});

function insertTestDecision(id: string): void {
  insertDecision({
    id,
    when_context: "2026-07-18",
    scope: "project",
    decision: `Decision ${id}`,
    choice: id,
    rationale: "replacement fence regression",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
}

test("active replacement intent fences coordination mutations before they change rows", async (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-coordination-");
  t.after(() => cleanup(base));
  openDatabase(databasePath);

  insertMilestone({ id: "M001", title: "Fence", status: "active" });
  for (const sliceId of ["S01", "S02", "S03"]) {
    insertSlice({ id: sliceId, milestoneId: "M001", title: sliceId });
  }
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  const commandId = enqueueCommand({ targetWorker: workerId, command: "pause" });
  assert.ok(claimNextCommand(workerId));
  setRuntimeKv("worker", workerId, "cursor", { line: 7 });

  const dispatchIds = ["S01", "S02", "S03"].map((sliceId) => {
    const claim = recordDispatchClaim({
      traceId: `trace-${sliceId}`,
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: "M001",
      sliceId,
      unitType: "plan-slice",
      unitId: `M001/${sliceId}`,
    });
    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error("expected dispatch claim");
    return claim.dispatchId;
  });

  const heartbeatBefore = getAutoWorker(workerId)!.last_heartbeat_at;
  const leaseExpiryBefore = getMilestoneLease("M001")!.expires_at;
  await new Promise((resolve) => setTimeout(resolve, 10));
  createReplacementIntent(databasePath);

  const fenced = /Database writes are fenced while replacement intent exists/;
  assert.throws(() => heartbeatAutoWorker(workerId), fenced);
  assert.throws(() => completeCommand(commandId, workerId, { acknowledged: true }), fenced);
  assert.throws(
    () => refreshMilestoneLease(workerId, "M001", lease.token),
    fenced,
  );
  assert.throws(() => deleteRuntimeKv("worker", workerId, "cursor"), fenced);
  assert.throws(() => markRunning(dispatchIds[0]!), fenced);
  assert.throws(() => markPaused(dispatchIds[1]!), fenced);
  assert.throws(() => markCanceled(dispatchIds[2]!, "replacement"), fenced);

  assert.equal(getAutoWorker(workerId)!.last_heartbeat_at, heartbeatBefore);
  assert.equal(getCommand(commandId)!.completed_at, null);
  assert.equal(getMilestoneLease("M001")!.expires_at, leaseExpiryBefore);
  assert.deepEqual(getRuntimeKv("worker", workerId, "cursor"), { line: 7 });
  for (const sliceId of ["S01", "S02", "S03"]) {
    assert.equal(getLatestForUnit(`M001/${sliceId}`)!.status, "claimed");
  }
});

test("active replacement intent prevents worktree reconciliation from mutating main", (t) => {
  const main = makeDatabasePath("gsd-replacement-reconcile-main-");
  const worktree = makeDatabasePath("gsd-replacement-reconcile-wt-");
  t.after(() => cleanup(main.base, worktree.base));

  openDatabase(main.databasePath);
  insertTestDecision("D001");
  closeDatabase();
  assert.equal(copyWorktreeDb(main.databasePath, worktree.databasePath), true);

  openDatabase(worktree.databasePath);
  insertTestDecision("D002");
  closeDatabase();

  openDatabase(main.databasePath);
  createReplacementIntent(main.databasePath);
  const result = reconcileWorktreeDb(main.databasePath, worktree.databasePath);

  assert.deepEqual(result, {
    decisions: 0,
    requirements: 0,
    artifacts: 0,
    milestones: 0,
    slices: 0,
    tasks: 0,
    memories: 0,
    replan_history: 0,
    assessments: 0,
    quality_gates: 0,
    slice_dependencies: 0,
    verification_evidence: 0,
    gate_runs: 0,
    milestone_commit_attributions: 0,
    conflicts: [],
  });
  assert.equal(getDecisionById("D002"), null);
  assert.deepEqual(
    _getAdapter()!.prepare("PRAGMA database_list").all().map((row) => row["name"]),
    ["main"],
    "worktree database is detached after the fenced transaction",
  );
});
