/**
 * Regression test for #2705: Web UI shows "Start auto" even while auto mode is
 * already running.
 *
 * Root cause: collectAuthoritativeAutoDashboardData spawns a subprocess that
 * imports auto.ts fresh. The module-level AutoSession state (s.active) is
 * always false in a new process, so the subprocess always reports
 * { active: false } even when auto IS running in the parent process.
 *
 * Fix: the subprocess reads the run state from the project database — an open
 * pause row, else an active worker row whose process runs now. The auto.lock
 * and paused-session.json files are not read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerAutoWorker } from "../../resources/extensions/gsd/db/auto-workers.ts";
import { openAutoPause } from "../../resources/extensions/gsd/db/writers/auto-pauses.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../../resources/extensions/gsd/gsd-db.ts";
import {
  collectAuthoritativeAutoDashboardData,
} from "../../web/auto-dashboard-service.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEAD_PID = 999999999;

function makeTempFixture(): { projectCwd: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-auto-lock-test-")));
  const projectCwd = join(root, "project");
  mkdirSync(join(projectCwd, ".gsd"), { recursive: true });
  return {
    projectCwd,
    cleanup: () => {
      try { closeDatabase(); } catch { /* best-effort */ }
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeAutoModule(dir: string, payload: Record<string, unknown>): string {
  const modulePath = join(dir, "fake-auto-dashboard.mjs");
  writeFileSync(
    modulePath,
    `export function getAutoDashboardData() { return ${JSON.stringify(payload)}; }\n`,
  );
  return modulePath;
}

/** Fill the project database, then close it so the subprocess reads it. */
function seedDatabase(projectCwd: string, seed: () => void): void {
  openDatabase(join(projectCwd, ".gsd", "gsd.db"));
  seed();
  closeDatabase();
}

function writeSessionLock(projectCwd: string, pid: number): void {
  const now = new Date().toISOString();
  writeFileSync(
    join(projectCwd, ".gsd", "auto.lock"),
    JSON.stringify({ pid, startedAt: now, unitType: "execute-task", unitId: "M001/S01/T01", unitStartedAt: now }),
  );
}

function writePausedSessionFile(projectCwd: string): void {
  const runtimeDir = join(projectCwd, ".gsd", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "paused-session.json"),
    JSON.stringify({ milestoneId: "M001", pausedAt: new Date().toISOString(), stepMode: false }),
  );
}

const INACTIVE_PAYLOAD = {
  active: false,
  paused: false,
  stepMode: false,
  startTime: 0,
  elapsed: 0,
  currentUnit: null,
  completedUnits: [],
  basePath: "",
  totalCost: 0,
  totalTokens: 0,
};

function collect(projectCwd: string, payload: Record<string, unknown> = INACTIVE_PAYLOAD) {
  return collectAuthoritativeAutoDashboardData(repoRoot, {
    env: {
      ...process.env,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: writeAutoModule(projectCwd, payload),
      GSD_WEB_PROJECT_CWD: projectCwd,
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

test("#2705 regression: subprocess reports active=false but a worker row has a live process → active=true", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  // The worker row carries this test process's PID: auto runs in the parent.
  seedDatabase(fixture.projectCwd, () => {
    registerAutoWorker({ projectRootRealpath: fixture.projectCwd });
  });

  const result = await collect(fixture.projectCwd);

  assert.equal(result.active, true, "active must be true when the worker process is alive");
  assert.equal(result.paused, false, "paused must remain false when no pause is open");
});

test("#2705: no project database → remains inactive", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const result = await collect(fixture.projectCwd);

  assert.equal(result.active, false);
  assert.equal(result.paused, false);
});

test("#2705: subprocess reports active=false but a pause row is open → paused=true", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  // A paused session keeps its process, so its worker row is live too.
  seedDatabase(fixture.projectCwd, () => {
    registerAutoWorker({ projectRootRealpath: fixture.projectCwd });
    openAutoPause({ blockerKind: "user_request", milestoneId: "M001", originalBasePath: fixture.projectCwd });
  });

  const result = await collect(fixture.projectCwd);

  assert.equal(result.paused, true, "paused must be true when a pause row is open");
  assert.equal(result.active, false, "active must remain false when paused (paused overrides active)");
});

test("#2705: subprocess reports active=true → the database is not consulted", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  const result = await collect(fixture.projectCwd, {
    ...INACTIVE_PAYLOAD,
    active: true,
    stepMode: true,
    startTime: 1000,
    elapsed: 500,
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1000 },
    basePath: fixture.projectCwd,
  });

  assert.equal(result.active, true, "active should remain true when subprocess already reports it");
});

test("#2705: the worker process is dead → remains inactive", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  seedDatabase(fixture.projectCwd, () => {
    const workerId = registerAutoWorker({ projectRootRealpath: fixture.projectCwd });
    _getAdapter()!.prepare(`UPDATE workers SET pid = :pid WHERE worker_id = :w`).run({ ":pid": DEAD_PID, ":w": workerId });
  });

  const result = await collect(fixture.projectCwd);

  assert.equal(result.active, false, "a worker row of a dead process is not a running session");
});

test("auto.lock and paused-session.json written by hand do not change the run state", async (t) => {
  const fixture = makeTempFixture();
  t.after(() => fixture.cleanup());

  // The database holds no worker and no pause. The files claim both.
  seedDatabase(fixture.projectCwd, () => {});
  writeSessionLock(fixture.projectCwd, process.pid);
  writePausedSessionFile(fixture.projectCwd);

  const result = await collect(fixture.projectCwd);

  assert.equal(result.active, false, "a lock file with a live PID is not a running session");
  assert.equal(result.paused, false, "a paused-session.json file is not a pause");
});
