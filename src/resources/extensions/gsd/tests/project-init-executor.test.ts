import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeWorkflowDatabase } from "../db-workspace.js";
import { executeProjectInit } from "../tools/project-init.js";

test("native project initialization is idempotent and can switch project roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-project-init-executor-"));
  t.after(() => { closeWorkflowDatabase(); rmSync(root, { recursive: true, force: true }); });
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const initialized = await executeProjectInit({}, first);
  assert.equal(initialized.details.ok, true);
  assert.equal(initialized.details.created, true);
  assert.equal(existsSync(join(first, ".gsd", "gsd.db")), true);
  const repeated = await executeProjectInit({}, first);
  assert.equal(repeated.details.ok, true);
  assert.equal(repeated.details.created, false);
  const switched = await executeProjectInit({ projectDir: second }, first);
  assert.equal(switched.details.ok, true);
  assert.equal(switched.details.projectDir, second);
  assert.equal(existsSync(join(second, ".gsd", "gsd.db")), true);
});

test("native project initialization does not create a missing project root", async () => {
  const missing = join(tmpdir(), `gsd-missing-project-${process.pid}`);
  const result = await executeProjectInit({ projectDir: missing }, process.cwd());
  assert.equal(result.details.error, "project_dir_missing");
  assert.equal(existsSync(missing), false);
});
