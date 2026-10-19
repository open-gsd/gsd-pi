/**
 * `gsd read roadmap` DB-authoritative wiring (ADR-046).
 *
 * When a project DB is present and openable, the roadmap envelope comes from
 * database rows: deleted or contradicting projection files do not change it.
 * The projection reader is the labelled fallback for a project with no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReadCli, type DbRoadmapReader, type ReadCliSchemaPreflight } from "../read-cli.ts";
import {
  openWorkflowDatabaseIsolated,
  resolveProjectRootDbPath,
} from "../resources/extensions/gsd/db-workspace.ts";
import { SCHEMA_VERSION, SchemaTooNewError } from "../resources/extensions/gsd/db/engine.ts";
import { readRoadmapFromDb } from "../resources/extensions/gsd/state/external-reads-from-db.ts";
import { poisonProjections } from "../resources/extensions/gsd/tests/db-authority-gate.ts";
import { createWorkflowAuthorityFixture } from "../resources/extensions/gsd/tests/workflow-authority-fixture.ts";

const preflight: ReadCliSchemaPreflight = {
  resolveProjectRootDbPath,
  openIsolatedDatabase: (path) => openWorkflowDatabaseIsolated(path),
  supportedSchemaVersion: SCHEMA_VERSION,
  createSchemaTooNewError: (currentVersion, supportedVersion) =>
    new SchemaTooNewError(currentVersion, supportedVersion),
};

async function readRoadmapCli(base: string, reader: DbRoadmapReader) {
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
      ["node", "gsd", "read", "roadmap", "--json", "--project", base],
      preflight,
      undefined,
      undefined,
      undefined,
      undefined,
      reader,
    );
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test("gsd read roadmap returns the database hierarchy when the projection files contradict it", async (t) => {
  // Fixture rows: M001 active; S01 complete (T01 complete); S02 pending (T01 pending).
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  poisonProjections(fixture.root);

  const run = await readRoadmapCli(fixture.root, readRoadmapFromDb);

  assert.equal(run.exitCode, 0, run.stderr);
  const { kind, data } = JSON.parse(run.stdout);
  assert.equal(kind, "roadmap");
  assert.deepEqual(data.readMetadata, { source: "database", authority: "db-authoritative" });
  assert.deepEqual(
    data.milestones.map((milestone: any) => ({
      id: milestone.id,
      status: milestone.status,
      slices: milestone.slices.map((slice: any) => [slice.id, slice.status, slice.tasks.map((task: any) => task.status)]),
    })),
    [{ id: "M001", status: "active", slices: [["S01", "done", ["done"]], ["S02", "pending", ["pending"]]] }],
  );
});

test("gsd read roadmap labels the projection read when the project has no database", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-read-cli-roadmap-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001: From File\n");

  let calls = 0;
  const run = await readRoadmapCli(base, () => {
    calls++;
    return null;
  });

  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(calls, 0, "the DB reader is not used when no DB file exists");
  const { data } = JSON.parse(run.stdout);
  assert.deepEqual(data.readMetadata, { source: "projection", authority: "projection-fallback" });
  assert.deepEqual(data.milestones.map((milestone: any) => milestone.title), ["From File"]);
});

test("gsd read roadmap refuses loudly when the DB-backed read fails", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  const run = await readRoadmapCli(fixture.root, () => {
    throw new Error("boom");
  });

  assert.equal(run.exitCode, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /DB-backed roadmap read failed: boom/);
});
