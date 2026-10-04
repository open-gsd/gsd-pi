/**
 * definition-io.ts — unit tests for readFrozenDefinition.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readFrozenDefinition } from "../definition-io.ts";
import { initializeGraph, writeGraph } from "../graph.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { importRunDirectory } from "../run-manager.ts";

function createTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "gsd-defio-test-")));
}

const DEFINITION = [
  "version: 1",
  "name: test-workflow",
  "description: A test workflow",
  "steps:",
  "  - id: step-1",
  "    name: Step 1",
  "    prompt: do the thing",
].join("\n");

describe("readFrozenDefinition", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = createTmpDir();
    assert.equal(openDatabase(":memory:"), true);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(runDir, { recursive: true, force: true });
  });

  test("returns the definition of the run row, not an edited DEFINITION.yaml", () => {
    writeFileSync(join(runDir, "DEFINITION.yaml"), DEFINITION, "utf-8");
    writeGraph(runDir, initializeGraph({
      version: 1,
      name: "test-workflow",
      steps: [{ id: "step-1", name: "Step 1", prompt: "do the thing", requires: [], produces: [] }],
    }));
    importRunDirectory(runDir);
    writeFileSync(join(runDir, "DEFINITION.yaml"), DEFINITION.replace("do the thing", "edited by hand"), "utf-8");

    const def = readFrozenDefinition(runDir);
    assert.equal(def.version, 1);
    assert.equal(def.name, "test-workflow");
    assert.equal(def.description, "A test workflow");
    assert.equal(def.steps.length, 1);
    assert.equal(def.steps[0].id, "step-1");
    assert.equal(def.steps[0].prompt, "do the thing");
  });

  test("throws when the run has no run row, also when DEFINITION.yaml exists", () => {
    writeFileSync(join(runDir, "DEFINITION.yaml"), DEFINITION, "utf-8");
    assert.throws(() => readFrozenDefinition(runDir), /has no database rows/);
  });
});
