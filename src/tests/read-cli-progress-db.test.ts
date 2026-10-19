/**
 * `gsd read progress` DB-authoritative wiring (#2101).
 *
 * When a project DB is present and openable, the envelope data must come
 * from the DB-backed reader (ADR-046: the DB is the workflow authority, a
 * projection can lag it). A missing or unopenable DB keeps the projection
 * fallback; a failing DB-backed read refuses loudly instead of degrading
 * to projections. The reader is exercised through its injectable seam —
 * the same pattern as the schema-version preflight tests — so these cases
 * pin the wiring and fallback decisions, not the derivation itself (pinned
 * by tests/progress-from-db.test.ts in the extension).
 */

import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { assertProgressPayload } from "../../scripts/mcp-host-smoke.mjs";
import { createWorkflowAuthorityFixture } from "../resources/extensions/gsd/tests/workflow-authority-fixture.ts";
import {
  runReadCli,
  type DbProgressModuleImporter,
  type DbProgressReader,
  type ReadCliSchemaPreflight,
} from "../read-cli.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../resources/extensions/gsd/gsd-db.ts";
import {
  openWorkflowDatabaseIsolated,
  resolveProjectRootDbPath,
} from "../resources/extensions/gsd/db-workspace.ts";
import { SCHEMA_VERSION, SchemaTooNewError } from "../resources/extensions/gsd/db/engine.ts";
import { readProgressFromDb } from "../resources/extensions/gsd/state/progress-from-db.ts";

const realPreflight: ReadCliSchemaPreflight = {
  resolveProjectRootDbPath,
  openIsolatedDatabase: (path) => openWorkflowDatabaseIsolated(path),
  supportedSchemaVersion: SCHEMA_VERSION,
  createSchemaTooNewError: (currentVersion, supportedVersion) =>
    new SchemaTooNewError(currentVersion, supportedVersion),
};

// Probe that never opens — simulates a locked/unreadable DB during the
// read-only schema check before the DB-backed reader reaches its own open.
const lockedPreflight: ReadCliSchemaPreflight = {
  resolveProjectRootDbPath,
  openIsolatedDatabase: () => null,
  supportedSchemaVersion: SCHEMA_VERSION,
  createSchemaTooNewError: (currentVersion, supportedVersion) =>
    new SchemaTooNewError(currentVersion, supportedVersion),
};

interface CaptureOpts {
  preflight?: ReadCliSchemaPreflight;
  reader?: DbProgressReader;
  moduleImporter?: DbProgressModuleImporter;
}

async function captureReadCli(argv: string[], opts: CaptureOpts = {}) {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exitCode = await runReadCli(
      argv,
      opts.preflight ?? realPreflight,
      opts.reader,
      opts.moduleImporter,
    );
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function readProgressArgv(base: string): string[] {
  return ["node", "gsd", "read", "progress", "--json", "--project", base];
}

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-read-cli-progress-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# Project State\n\n**Phase:** planning\n",
  );
  return base;
}

test("gsd read progress serves the DB-backed payload when the project DB is present and openable", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const sentinel = { phase: "db-derived", activeMilestone: { id: "M001", title: "From DB" } };
  let calls = 0;
  const run = await captureReadCli(readProgressArgv(base), {
    reader: async (projectDir) => {
      calls++;
      assert.equal(projectDir, base);
      return sentinel;
    },
  });
  assert.equal(run.exitCode, 0);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.kind, "progress");
  assert.deepEqual(envelope.data, sentinel);
  assert.equal(calls, 1);
});

test("gsd read progress uses the project DB from a canonical milestone worktree", async (t) => {
  const base = makeProject();
  const worktree = join(base, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".gsd", "STATE.md"), "# Project State\n\n**Phase:** planning\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const sentinel = { phase: "project-db-derived" };
  const run = await captureReadCli(readProgressArgv(worktree), {
    reader: async (projectDir) => {
      assert.equal(projectDir, worktree);
      return sentinel;
    },
  });

  assert.equal(run.exitCode, 0);
  assert.deepEqual(JSON.parse(run.stdout).data, sentinel);
});

test("gsd read progress lets the DB reader decide availability after schema preflight", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const sentinel = { phase: "db-derived-after-preflight" };
  const run = await captureReadCli(readProgressArgv(base), {
    preflight: lockedPreflight,
    reader: async () => sentinel,
  });
  assert.equal(run.exitCode, 0);
  const envelope = JSON.parse(run.stdout);
  assert.deepEqual(envelope.data, sentinel);
});

test("gsd read progress falls back when the DB disappears before the DB reader opens it", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  const run = await captureReadCli(readProgressArgv(base), {
    reader: async (projectDir) => {
      rmSync(dbPath, { force: true });
      return readProgressFromDb(projectDir);
    },
  });

  assert.equal(run.exitCode, 0);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.data.phase, "planning");
  assert.deepEqual(envelope.data.readMetadata, { source: "projection", authority: "projection-fallback" });
});

test("gsd read progress refuses loudly when the DB-backed read fails", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = await captureReadCli(readProgressArgv(base), {
    reader: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.ok(
    run.stderr.includes("DB-backed progress read failed"),
    `stderr should explain the failure, got: ${run.stderr}`,
  );
  assert.ok(run.stderr.includes("boom"), `stderr should carry the cause, got: ${run.stderr}`);
});

test("gsd read progress explains how to repair a stale extension bundle", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = await captureReadCli(readProgressArgv(base), {
    moduleImporter: async () => {
      throw new Error("Cannot find module state/progress-from-db.ts");
    },
  });

  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /synchronize the extension bundle/);
});

test("gsd read progress does not invoke the DB reader when no DB exists", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  let calls = 0;
  const run = await captureReadCli(readProgressArgv(base), {
    reader: async () => {
      calls++;
      return { phase: "should-not-appear" };
    },
  });
  assert.equal(run.exitCode, 0);
  assert.equal(calls, 0);
  const envelope = JSON.parse(run.stdout);
  assert.equal(envelope.kind, "progress");
  assert.equal(envelope.data.phase, "planning");
  assert.deepEqual(envelope.data.readMetadata, { source: "projection", authority: "projection-fallback" });
});

test("gsd read progress preserves DB read metadata when the DB reader supplies it", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = await captureReadCli(readProgressArgv(base), {
    reader: async () => ({
      phase: "db-derived",
      readMetadata: { source: "database", authority: "db-authoritative" },
    }),
  });

  assert.equal(run.exitCode, 0);
  const envelope = JSON.parse(run.stdout);
  assert.deepEqual(envelope.data.readMetadata, { source: "database", authority: "db-authoritative" });
});

// ---------------------------------------------------------------------------
// Composition with the production canonical smoke assertions (#2669): the
// real registered CLI (fresh subprocess of the built entry, no injected
// seams) feeds its actual payload into the same assertions the MCP host
// smoke probe enforces.
// ---------------------------------------------------------------------------

// Resolve the repo root from either the source tree or the mirrored
// dist-test tree, so the spawned CLI entry is the real built one.
function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 10 && dir; depth++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = join(dir, "..");
  }
  throw new Error("repo root not found from " + import.meta.dirname);
}

function runRealCli(projectDir: string): { status: number; stdout: string; stderr: string } {
  const entry = resolve(findRepoRoot(), "dist/bootstrap.js");
  const result = spawnSync(
    process.execPath,
    [entry, "read", "progress", "--json", "--project", projectDir],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, GSD_NON_INTERACTIVE: "1" } },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("composition: real DB-backed CLI read passes the production smoke assertion", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  writeFileSync(
    join(fixture.root, ".gsd", "STATE.md"),
    "**Active Milestone:** M999: Projection Only\n**Phase:** plan\n",
  );

  const run = runRealCli(fixture.root);
  assert.equal(run.status, 0, `CLI read failed: ${run.stderr}`);
  const progress = assertProgressPayload(JSON.parse(run.stdout).data);
  assert.equal(progress.activeMilestone?.id, "M001");
  assert.equal(progress.activeMilestone?.title, "Authority Fixture");
});

test("composition: a valid empty real DB returns DB authority, not the STATE.md projection", async (t) => {
  const base = makeProject();
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# Project State\n\n**Active Milestone:** M999: Projection Only\n**Phase:** planning\n",
  );
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  closeDatabase();

  const run = runRealCli(base);
  assert.equal(run.status, 0, `CLI read failed: ${run.stderr}`);
  const payload = JSON.parse(run.stdout).data;
  assert.deepEqual(payload.readMetadata, { source: "database", authority: "db-authoritative" });
  const progress = assertProgressPayload(payload);
  assert.equal(progress.activeMilestone, null, "empty DB must not report the STATE.md milestone");
  assert.equal(progress.milestones.total, 0);
});

test("composition: the real projection fallback is labelled and rejected by canonical validation", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const run = runRealCli(base);
  assert.equal(run.status, 0);
  const payload = JSON.parse(run.stdout).data;
  assert.deepEqual(payload.readMetadata, { source: "projection", authority: "projection-fallback" });
  // A bare STATE.md projection can fail on nextAction before provenance is
  // inspected; the strict provenance rejection (projection source must be
  // refused) is pinned in scripts/__tests__/mcp-host-smoke.test.mjs. Either
  // failure means the compatibility fallback cannot pass canonical validation.
  assert.throws(
    () => assertProgressPayload(payload),
    /readMetadata\.source: expected database|nextAction: expected non-empty string/,
    "canonical smoke validation must reject the compatibility projection read",
  );
});

test("composition: a query failure after a successful open fails closed with no payload", async (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter, "adapter should be available");
  // Schema damage is healed by a fresh open; deleting the authority row is
  // not, so the read fails after a successful open instead of degrading.
  adapter.prepare("DELETE FROM project_authority").run();
  closeDatabase();

  const run = runRealCli(base);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "", "no stale projection payload may be emitted after a query failure");
  assert.ok(run.stderr.includes("DB-backed progress read failed"), `stderr should explain the failure, got: ${run.stderr}`);
});
