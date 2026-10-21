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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runReadCli,
  type DbProgressModuleImporter,
  type DbProgressReader,
  type ReadCliSchemaPreflight,
} from "../read-cli.ts";
import { closeDatabase, openDatabase } from "../resources/extensions/gsd/gsd-db.ts";
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
  assert.equal(envelope.data.phase, "plan");
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
  assert.equal(envelope.data.phase, "plan");
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
