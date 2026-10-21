// Regression tests for #2831: audit logs must land in each project's own
// state directory under external state, not in a shared
// $GSD_STATE_DIR/projects/.gsd/ directory.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkflowDatabase, resolveWorkflowDatabaseLocation } from "../db-workspace.ts";
import { closeDatabase } from "../gsd-db.ts";
import { normalizeRealPath } from "../paths.ts";
import {
  _resetLogs,
  logError,
  logWarning,
  setLogBasePath,
  setStderrLoggingEnabled,
} from "../workflow-logger.ts";
import {
  getUnifiedAuditOverride,
  restoreUnifiedAuditOverride,
  setUnifiedAuditEnabled,
} from "../uok/audit-toggle.ts";

interface ExternalStateFixture {
  /** The project checkout root. */
  base: string;
  /** The shared directory that holds every project's state ($GSD_STATE_DIR/projects). */
  stateProjects: string;
  /** This project's own state directory (<stateProjects>/<hash>). */
  projectState: string;
}

/** Symlink errors that mean "this platform cannot take this fixture", not a bug. */
const SYMLINK_UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * External-state layout: `.gsd` is a symlink into a shared projects root, the
 * shape `migrateToExternalState` produces (without depending on repo identity
 * hashing).
 *
 * Returns null when the platform cannot create directory symlinks; callers skip.
 */
function makeExternalStateProject(stateProjects: string, hash: string): ExternalStateFixture | null {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-2831-proj-")));
  const projectState = join(stateProjects, hash);
  mkdirSync(projectState, { recursive: true });
  try {
    symlinkSync(projectState, join(base, ".gsd"), "dir");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    rmSync(base, { recursive: true, force: true });
    if (SYMLINK_UNSUPPORTED.has(code)) return null;
    throw err;
  }
  return { base, stateProjects, projectState };
}

function cleanupFixture(fixture: ExternalStateFixture): void {
  rmSync(fixture.base, { recursive: true, force: true });
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("resolveWorkflowDatabaseLocation derives projectRoot from the path contract (#2831)", (t) => {
  const stateProjects = realpathSync(mkdtempSync(join(tmpdir(), "gsd-2831-state-")));
  t.after(() => rmSync(stateProjects, { recursive: true, force: true }));
  const fixture = makeExternalStateProject(stateProjects, "abc123hash");
  if (!fixture) return t.skip("directory symlinks unavailable on this platform");
  t.after(() => cleanupFixture(fixture));

  const location = resolveWorkflowDatabaseLocation(fixture.base);

  assert.equal(
    normalizeRealPath(location.projectRoot),
    normalizeRealPath(fixture.base),
    "projectRoot must be the project checkout, not the DB path's grandparent",
  );
  assert.equal(
    normalizeRealPath(location.projectGsd),
    normalizeRealPath(fixture.projectState),
    "projectGsd must resolve through the .gsd symlink to the state directory",
  );
  assert.equal(
    normalizeRealPath(location.projectDb),
    normalizeRealPath(join(fixture.projectState, "gsd.db")),
    "projectDb must be the state directory's gsd.db",
  );
});

test("workflow database open wires audit logs to the project's own state dir (#2831)", (t) => {
  const stateProjects = realpathSync(mkdtempSync(join(tmpdir(), "gsd-2831-state-")));
  const fixture = makeExternalStateProject(stateProjects, "abc123hash");
  if (!fixture) {
    rmSync(stateProjects, { recursive: true, force: true });
    return t.skip("directory symlinks unavailable on this platform");
  }
  const stderrWasEnabled = setStderrLoggingEnabled(false);
  const savedAuditOverride = getUnifiedAuditOverride();
  // t.after runs FIFO — close the database before its directory is removed.
  t.after(() => {
    closeDatabase();
    cleanupFixture(fixture);
    rmSync(stateProjects, { recursive: true, force: true });
    _resetLogs();
    setLogBasePath("");
    restoreUnifiedAuditOverride(savedAuditOverride);
    setStderrLoggingEnabled(stderrWasEnabled);
  });

  setUnifiedAuditEnabled(true);

  const opened = openWorkflowDatabase(fixture.base);
  assert.equal(opened.ok, true, `open should succeed, got: ${JSON.stringify(opened)}`);

  // The error audit log and the unified audit events projection are both
  // derived from the log base path set during open.
  logError("db", "audit derivation probe");
  logWarning("db", "audit events probe");

  const auditLog = join(fixture.projectState, "audit-log.jsonl");
  assert.ok(existsSync(auditLog), "error audit log must land in the project's own state directory");
  const entries = readJsonl(auditLog);
  assert.ok(
    entries.some((entry) => entry["message"] === "audit derivation probe"),
    `audit log must contain the probe entry; got: ${JSON.stringify(entries)}`,
  );
  assert.ok(
    !existsSync(join(fixture.stateProjects, ".gsd", "audit-log.jsonl")),
    "error audit log must not land in a shared projects/.gsd directory",
  );

  const events = join(fixture.projectState, "audit", "events.jsonl");
  assert.ok(existsSync(events), "unified audit events must land in the project's own state directory");
  const envelopes = readJsonl(events);
  assert.ok(
    envelopes.some((event) => event["type"] === "workflow-log-warn"),
    `events.jsonl must contain the probe event; got: ${JSON.stringify(envelopes)}`,
  );
  assert.ok(
    !existsSync(join(fixture.stateProjects, ".gsd", "audit", "events.jsonl")),
    "unified audit events must not land in a shared projects/.gsd directory",
  );
});

test("two external-state projects sharing one state parent keep separate audit logs (#2831)", (t) => {
  const stateProjects = realpathSync(mkdtempSync(join(tmpdir(), "gsd-2831-state-")));
  const projectA = makeExternalStateProject(stateProjects, "hash-a");
  const projectB = makeExternalStateProject(stateProjects, "hash-b");
  if (!projectA || !projectB) {
    if (projectA) cleanupFixture(projectA);
    if (projectB) cleanupFixture(projectB);
    rmSync(stateProjects, { recursive: true, force: true });
    return t.skip("directory symlinks unavailable on this platform");
  }
  const stderrWasEnabled = setStderrLoggingEnabled(false);
  // t.after runs FIFO — close the database before its directory is removed.
  t.after(() => {
    closeDatabase();
    cleanupFixture(projectA);
    cleanupFixture(projectB);
    rmSync(stateProjects, { recursive: true, force: true });
    _resetLogs();
    setLogBasePath("");
    setStderrLoggingEnabled(stderrWasEnabled);
  });

  const openAndLog = (fixture: ExternalStateFixture, probe: string): void => {
    const opened = openWorkflowDatabase(fixture.base);
    assert.equal(opened.ok, true, `open ${fixture.base} should succeed`);
    logError("db", probe);
    closeDatabase();
  };

  openAndLog(projectA, "probe-project-a");
  openAndLog(projectB, "probe-project-b");

  const logA = readJsonl(join(projectA.projectState, "audit-log.jsonl")).map((e) => e["message"]);
  const logB = readJsonl(join(projectB.projectState, "audit-log.jsonl")).map((e) => e["message"]);
  assert.ok(logA.includes("probe-project-a"), `project A log must hold its own probe; got ${JSON.stringify(logA)}`);
  assert.ok(logB.includes("probe-project-b"), `project B log must hold its own probe; got ${JSON.stringify(logB)}`);
  assert.ok(!logA.includes("probe-project-b"), "project A log must not receive project B events");
  assert.ok(!logB.includes("probe-project-a"), "project B log must not receive project A events");
  assert.ok(
    !existsSync(join(stateProjects, ".gsd")),
    "no shared projects/.gsd directory may be created",
  );
});
