// Hermetic bootstrap UNIT tests. No database is opened and no authority changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../bootstrap/dynamic-tools.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function harness() {
  const state = {
    result: { ok: false, reason: "missing-database", location: { projectDb: "/private/project/.gsd/gsd.db" } } as any,
    calls: [] as any[],
    warnings: [] as any[],
  };
  const exports: Record<string, any> = {};
  runInNewContext(outputText, {
    exports,
    require(id: string) {
      if (id === "../db-workspace.js") return {
        openWorkflowDatabase: (...args: any[]) => { state.calls.push(args); return state.result; },
        getWorkflowDatabaseStatus: () => ({ phase: "closed" }),
      };
      if (id === "../workflow-logger.js") return {
        logWarning: (...args: any[]) => state.warnings.push(args),
      };
      if (id === "../db-provider.js") return { supportsRequiredSqliteApi: () => true };
      if (id.startsWith("node:")) return require(id);
      return {};
    },
    process,
    console,
  });
  return { state, api: exports };
}

test("UNIT: shadow error preserves distinct allowlisted DB-open reasons", () => {
  const h = harness();
  for (const reason of ["missing-database", "missing-gsd-dir", "locked", "open-failed", "schema-too-new", "authority-missing", "checkout-unbound"]) {
    const error = h.api.dbOpenFailureForObservation(reason);
    assert.equal(error.message, `GSD database is not available [open:${reason}]`);
  }
  assert.equal(h.state.calls.length, 0);
});

test("UNIT: shadow error never copies malformed or sensitive opening details", () => {
  const h = harness();
  for (const reason of [undefined, null, {}, { reason: "locked", path: "/private/customer" }, "token=fixture-private", "locked\n/private/customer"]) {
    assert.equal(h.api.dbOpenFailureForObservation(reason).message, "GSD database is not available");
  }
});

test("UNIT: unavailable DB retains boolean API and records only opening classification", async () => {
  const h = harness();
  const observation: { reason?: string } = {};
  assert.equal(await h.api.ensureDbOpen("/project", {}, observation), false);
  assert.equal(observation.reason, "missing-database");
  assert.deepEqual(Object.keys(observation), ["reason"]);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.warnings.length, 1);
});

test("UNIT: successful open clears a reused failure observation", async () => {
  const h = harness();
  h.state.result = { ok: true, reason: "opened-existing" };
  const observation = { reason: "missing-database" };
  assert.equal(await h.api.ensureDbOpen("/project", {}, observation), true);
  assert.equal(observation.reason, undefined);
  assert.equal(h.state.warnings.length, 0);
});

test("UNIT: optional observation does not change existing callers or open options", async () => {
  const h = harness();
  const options = { allowCreate: false };
  assert.equal(await h.api.ensureDbOpen("/project", options), false);
  assert.equal(h.state.calls[0][0], "/project");
  assert.equal(h.state.calls[0][1], options);
});

test("UNIT: authority and schema failures still throw instead of degrading to unavailable", async () => {
  for (const reason of ["schema-too-new", "authority-missing", "checkout-unbound"]) {
    const h = harness();
    const error = new Error("typed guard fixture");
    h.state.result = { ok: false, reason, error, location: {} };
    const observation: { reason?: string } = {};
    await assert.rejects(h.api.ensureDbOpen("/project", {}, observation), (actual: unknown) => actual === error);
    assert.equal(observation.reason, reason);
  }
});
