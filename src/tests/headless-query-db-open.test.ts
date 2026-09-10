/**
 * Regression test for #4123: headless-query must open the project DB
 * before deriveState(), otherwise it falls back to filesystem parsing.
 *
 * Extended for T005: a SchemaTooNewError propagating out of deriveState
 * (newer-schema project) must refuse loudly — exact engine message on
 * stderr, non-zero exit, no degraded all-zero payload — while a genuinely
 * DB-unavailable project keeps the existing degraded exit-0 path.
 *
 * The fixture runs exercise the REAL read seam (engine → db-workspace →
 * state/derive/db-open → deriveState) through direct imports; the CLI
 * boundary (runHeadlessQuery) is then driven with the exact error/state the
 * real seam produced, mirroring how loadExtensionModules wires it in
 * production.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadlessQuery } from "../headless-query.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../resources/extensions/gsd/gsd-db.ts";
import { recordSchemaVersion } from "../resources/extensions/gsd/db-schema-metadata.ts";
import { SchemaTooNewError } from "../resources/extensions/gsd/db/engine.ts";
import { deriveState } from "../resources/extensions/gsd/state.ts";

const V50_MESSAGE =
  "gsd.db schema is v50, newer than the v49 this gsd-pi supports. " +
  "Update gsd-pi (npm i -g @opengsd/gsd-pi) before opening this project.";

test("headless-query opens the DB before deriveState (#4123)", async () => {
  const calls: string[] = [];
  let output = "";

  const result = await runHeadlessQuery(
    "/tmp/project",
    {
      openProjectDbIfPresent: async (basePath: string) => {
        calls.push(`open:${basePath}`);
      },
      deriveState: async (basePath: string) => {
        calls.push(`derive:${basePath}`);
        return {
          phase: "complete",
          nextAction: "done",
          activeMilestone: undefined,
        };
      },
      resolveDispatch: async () => {
        throw new Error("resolveDispatch should not run without an active milestone");
      },
      readAllSessionStatuses: () => {
        calls.push("statuses");
        return [{ milestoneId: "M001", pid: 123, state: "running", cost: 1.25, lastHeartbeat: 10 }];
      },
      loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    } as any,
    (text) => {
      output += text;
    },
  );

  assert.deepEqual(calls, ["open:/tmp/project", "derive:/tmp/project", "statuses"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.data?.cost.total, 1.25);
  assert.equal(JSON.parse(output).cost.total, 1.25);
});

test("SchemaTooNewError from deriveState exits non-zero with the exact engine message", async () => {
  let output = "";
  let errors = "";

  const result = await runHeadlessQuery(
    "/tmp/project",
    {
      openProjectDbIfPresent: async () => {},
      deriveState: async () => {
        throw new SchemaTooNewError(50, 49);
      },
      resolveDispatch: async () => {
        throw new Error("resolveDispatch should not run after a refused deriveState");
      },
      readAllSessionStatuses: () => [],
      loadEffectiveGSDPreferences: () => ({ preferences: {} }),
    } as any,
    (text) => {
      output += text;
    },
    (text) => {
      errors += text;
    },
  );

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.data, undefined);
  assert.equal(output, "");
  assert.equal(errors, `[gsd] ${V50_MESSAGE}\n`);
});

test("non-version deriveState failures keep current handling (they propagate)", async () => {
  await assert.rejects(
    runHeadlessQuery(
      "/tmp/project",
      {
        openProjectDbIfPresent: async () => {},
        deriveState: async () => {
          throw new Error("disk exploded");
        },
        resolveDispatch: async () => ({}),
        readAllSessionStatuses: () => [],
        loadEffectiveGSDPreferences: () => ({ preferences: {} }),
      } as any,
      () => {},
      () => {},
    ),
    /disk exploded/,
  );
});

/** Real fixture project whose gsd.db is stamped one version above supported. */
function makeNewerSchemaProject(version: number): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-headless-query-v${version}-`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const db = _getAdapter();
  assert.ok(db);
  recordSchemaVersion(db, version);
  closeDatabase();
  return base;
}

test("newer-schema fixture: real deriveState refuses, and the CLI boundary exits non-zero with the exact message", async () => {
  const base = makeNewerSchemaProject(50);
  try {
    // Real read seam: engine refuse-newer → db-workspace "schema-too-new"
    // result → state/derive/db-open loud throw.
    let thrown: unknown;
    try {
      await deriveState(base);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof SchemaTooNewError, `expected SchemaTooNewError, got ${String(thrown)}`);
    assert.equal(thrown.message, V50_MESSAGE);

    // The headless-query boundary converts that exact error into a loud
    // non-zero refusal — never a degraded all-zero payload with exit 0.
    let output = "";
    let errors = "";
    const result = await runHeadlessQuery(
      base,
      {
        openProjectDbIfPresent: async () => {},
        deriveState: async () => {
          throw thrown;
        },
        resolveDispatch: async () => {
          throw new Error("resolveDispatch should not run after a refused deriveState");
        },
        readAllSessionStatuses: () => [],
        loadEffectiveGSDPreferences: () => ({ preferences: {} }),
      } as any,
      (text) => {
        output += text;
      },
      (text) => {
        errors += text;
      },
    );
    assert.notEqual(result.exitCode, 0);
    assert.equal(output, "");
    assert.equal(errors, `[gsd] ${V50_MESSAGE}\n`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("DB-unavailable fixture: real deriveState degrades, and the CLI boundary keeps exit 0", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-query-nodb-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });

    // Genuine unavailability (no gsd.db) still takes the fail-closed
    // degraded path.
    const state = await deriveState(base);
    assert.equal(state.activeMilestone, null);
    assert.ok(state.blockers.some((blocker) => blocker.includes("DB unavailable")));

    let output = "";
    const result = await runHeadlessQuery(
      base,
      {
        openProjectDbIfPresent: async () => {},
        deriveState: async () => state,
        resolveDispatch: async () => {
          throw new Error("resolveDispatch should not run without an active milestone");
        },
        readAllSessionStatuses: () => [],
        loadEffectiveGSDPreferences: () => ({ preferences: {} }),
      } as any,
      (text) => {
        output += text;
      },
    );
    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(output);
    assert.equal(payload.state.activeMilestone, null);
    assert.ok(payload.state.blockers.some((blocker: string) => blocker.includes("DB unavailable")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
