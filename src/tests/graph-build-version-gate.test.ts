// gsd-pi · graph build version gate (T003 spike, projection-write side)
//
// `gsd graph build` bypasses the DB and writes `.gsd/graphs/graph.json`
// directly, so without a version gate a project cut over by a NEWER gsd-pi
// silently gets a fresh empty graph with exit 0 (silent divergence). The CLI
// consults the schema stamp through the extension's
// openExistingWorkflowDatabase: `graph build` refuses with the exact engine
// refuse-newer message, a non-zero exit, and NO graph.json written; read-only
// subcommands (status/query/diff) warn loudly but keep exit 0; a missing
// gsd.db keeps the previous behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../resources/extensions/gsd/gsd-db.ts";
import { recordSchemaVersion } from "../resources/extensions/gsd/db-schema-metadata.ts";

const V51_MESSAGE =
  "gsd.db schema is v51, newer than the v50 this gsd-pi supports. " +
  "Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.";

function makeProject(version: "current" | "newer" | "missing"): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-graph-gate-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  if (version !== "missing") {
    try {
      assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
      if (version === "newer") {
        const db = _getAdapter();
        assert.ok(db);
        recordSchemaVersion(db, 51);
      }
    } finally {
      closeDatabase();
    }
  }
  return base;
}

function runGraph(base: string, args: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), "gsd-graph-gate-home-"));
  const env = {
    ...process.env,
    GSD_AGENT_DIR: join(home, "agent"),
    GSD_HOME: home,
    GSD_SUPPRESS_LOGO: "1",
  };
  delete env.NODE_TEST_CONTEXT;
  try {
    return spawnSync(process.execPath, [
      "--import",
      join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs"),
      "--experimental-strip-types",
      join(process.cwd(), "src/loader.ts"),
      "graph",
      ...args,
    ], {
      cwd: base,
      env,
      encoding: "utf8",
      timeout: 180_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("graph build on a newer-schema project refuses without writing graph.json", (t) => {
  const base = makeProject("newer");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const run = runGraph(base, ["build"]);

  assert.equal(run.status, 1, `refusal must exit non-zero:\n${run.stderr}`);
  assert.ok(
    run.stderr.includes(V51_MESSAGE),
    `stderr must carry the exact refuse-newer message:\n${run.stderr}`,
  );
  assert.equal(
    existsSync(join(base, ".gsd", "graphs", "graph.json")),
    false,
    "no graph.json may be written into a newer-schema project",
  );
});

test("graph build on a current-schema project keeps the exit-0 build path", (t) => {
  const base = makeProject("current");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const run = runGraph(base, ["build"]);

  assert.equal(run.status, 0, `same-version build must keep working:\n${run.stderr}`);
  assert.match(run.stdout, /Graph built:/);
  assert.equal(existsSync(join(base, ".gsd", "graphs", "graph.json")), true);
});

test("graph build with a missing gsd.db keeps the previous behavior", (t) => {
  const base = makeProject("missing");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const run = runGraph(base, ["build"]);

  assert.equal(run.status, 0, `missing DB must keep the previous build path:\n${run.stderr}`);
  assert.match(run.stdout, /Graph built:/);
});

test("graph status on a newer-schema project warns with the exact message but stays read-only", (t) => {
  const base = makeProject("newer");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const run = runGraph(base, ["status"]);

  assert.equal(run.status, 0, `read-only status must keep exit 0:\n${run.stderr}`);
  assert.ok(
    run.stderr.includes(V51_MESSAGE),
    `status must warn with the exact refuse-newer message:\n${run.stderr}`,
  );
  assert.equal(
    existsSync(join(base, ".gsd", "graphs", "graph.json")),
    false,
    "status must not create the graph artifact",
  );
});
