/**
 * T005 read seam: `gsd read` must refuse loudly on newer-schema projects.
 *
 * The markdown readers never open gsd.db, so without the read-only
 * schema-version preflight a project cut over by a newer gsd-pi would be
 * served as a degraded all-zero payload with exit 0 (T003 spike: silent
 * divergence). The preflight must:
 *   - exit NON-ZERO with the exact engine refuse-newer message on stderr
 *     when the project DB records a schema version above supported;
 *   - leave genuinely DB-unavailable projects (missing/corrupt gsd.db) on
 *     the existing degraded/fail-closed markdown path with exit 0.
 *
 * The preflight is exercised through its injectable seam (the same pattern
 * as runHeadlessQuery's modules parameter): the injected probe is built
 * from the REAL engine/db-workspace modules, so fixture runs open the real
 * fixture database read-only and construct the real SchemaTooNewError.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReadCli, type ReadCliSchemaPreflight } from "../read-cli.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../resources/extensions/gsd/gsd-db.ts";
import { recordSchemaVersion } from "../resources/extensions/gsd/db-schema-metadata.ts";
import {
  openWorkflowDatabaseIsolated,
  resolveProjectRootDbPath,
} from "../resources/extensions/gsd/db-workspace.ts";
import { SCHEMA_VERSION, SchemaTooNewError } from "../resources/extensions/gsd/db/engine.ts";
import { readProgressFromDb } from "../resources/extensions/gsd/state/progress-from-db.ts";

const V50_MESSAGE =
  "gsd.db schema is v50, newer than the v49 this gsd-pi supports. " +
  "Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.";

// Real preflight probe: the same pieces the production jiti loader wires up,
// loaded through this test process's module graph.
const realPreflight: ReadCliSchemaPreflight = {
  resolveProjectRootDbPath,
  openIsolatedDatabase: (path) => openWorkflowDatabaseIsolated(path),
  supportedSchemaVersion: SCHEMA_VERSION,
  createSchemaTooNewError: (currentVersion, supportedVersion) =>
    new SchemaTooNewError(currentVersion, supportedVersion),
};

async function captureReadCli(argv: string[], reader?: (projectDir: string) => Promise<unknown>) {
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
    const exitCode = await runReadCli(argv, realPreflight, reader);
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
  const base = mkdtempSync(join(tmpdir(), "gsd-read-cli-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# Project State\n\n**Phase:** planning\n",
  );
  return base;
}

test("gsd read progress --json on a newer-schema project exits non-zero with the exact refuse-newer message", async () => {
  const base = makeProject();
  try {
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const db = _getAdapter();
    assert.ok(db);
    recordSchemaVersion(db, 50);
    closeDatabase();

    const run = await captureReadCli(readProgressArgv(base));
    assert.notEqual(run.exitCode, 0);
    assert.equal(run.stdout, "");
    assert.ok(
      run.stderr.includes(V50_MESSAGE),
      `stderr should contain the exact engine message, got: ${run.stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("gsd read progress checks the project DB schema from a canonical milestone worktree", async (t) => {
  const base = makeProject();
  const worktree = join(base, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".gsd", "STATE.md"), "# Project State\n\n**Phase:** planning\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const db = _getAdapter();
  assert.ok(db);
  recordSchemaVersion(db, 50);
  closeDatabase();

  const run = await captureReadCli(readProgressArgv(worktree));

  assert.notEqual(run.exitCode, 0);
  assert.match(run.stderr, new RegExp(V50_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("gsd read progress --json on a current-schema project serves the DB-backed payload", async () => {
  const base = makeProject();
  try {
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    closeDatabase();

    // DB present + schema OK now prefers the DB-backed reader (#2101); the
    // injected sentinel proves the envelope carried DB data, not STATE.md.
    const sentinel = { phase: "db-derived" };
    const run = await captureReadCli(readProgressArgv(base), async () => sentinel);
    assert.equal(run.exitCode, 0);
    const envelope = JSON.parse(run.stdout);
    assert.equal(envelope.kind, "progress");
    assert.deepEqual(envelope.data, sentinel);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("gsd read progress --json without a gsd.db keeps the existing degraded exit-0 path", async () => {
  const base = makeProject();
  try {
    const run = await captureReadCli(readProgressArgv(base));
    assert.equal(run.exitCode, 0);
    const envelope = JSON.parse(run.stdout);
    assert.equal(envelope.kind, "progress");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("gsd read progress --json with an unreadable gsd.db keeps the existing degraded exit-0 path", async () => {
  const base = makeProject();
  try {
    writeFileSync(join(base, ".gsd", "gsd.db"), "not a sqlite database");

    const run = await captureReadCli(readProgressArgv(base), readProgressFromDb);
    assert.equal(run.exitCode, 0);
    const envelope = JSON.parse(run.stdout);
    assert.equal(envelope.kind, "progress");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
