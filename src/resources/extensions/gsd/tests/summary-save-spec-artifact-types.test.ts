// gsd-pi — SPEC and AI-SPEC artifact types of gsd_summary_save (P31b).
//
// The spec-phase and ai-integration-phase prompts route their artifacts
// through gsd_summary_save; the write guard refuses direct writes to the
// rendered files. These tests pin the save side: the tool computes the
// canonical path for the active layout, writes the projection and records
// the artifact row.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { closeDatabase, getArtifact, openDatabase } from "../gsd-db.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";

function setupBase(t: { after: (fn: () => void) => void }): string {
  const base = join(tmpdir(), `gsd-summary-save-spec-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

test("a milestone SPEC saves to the canonical milestone file and an artifact row", async (t) => {
  const base = setupBase(t);
  const result = await executeSummarySave({
    artifact_type: "SPEC",
    milestone_id: "M001",
    content: "# SPEC\n\nWhat this delivers, for whom, and the non-goals.",
  }, base);

  assert.equal(result.isError, undefined);
  const relPath = String(result.details.path);
  assert.match(relPath, /M001-SPEC\.md$|^[\d/]+01-SPEC\.md$|01-SPEC\.md$/);
  const file = join(base, ".gsd", relPath);
  assert.equal(existsSync(file), true, `expected the projection at ${file}`);
  assert.match(readFileSync(file, "utf8"), /non-goals/);
  assert.ok(getArtifact(relPath), "the artifact row is the source of the render");
});

test("a slice AI-SPEC saves into the slice directory", async (t) => {
  const base = setupBase(t);
  const result = await executeSummarySave({
    artifact_type: "AI-SPEC",
    milestone_id: "M001",
    slice_id: "S01",
    content: "# AI-SPEC\n\nInputs, outputs, evaluation, and the cost ceiling.",
  }, base);

  assert.equal(result.isError, undefined);
  const relPath = String(result.details.path);
  assert.match(relPath, /AI-SPEC\.md$/);
  const file = join(base, ".gsd", relPath);
  assert.equal(existsSync(file), true, `expected the projection at ${file}`);
  assert.ok(getArtifact(relPath), "the artifact row is recorded");
});

test("an artifact type outside the supported list is still refused", async (t) => {
  const base = setupBase(t);
  const result = await executeSummarySave({
    artifact_type: "ROADMAP-EXTRA",
    milestone_id: "M001",
    content: "x",
  }, base);

  assert.equal(result.isError, true);
  assert.match(String(result.content[0].text), /Invalid artifact_type/);
  assert.match(String(result.content[0].text), /AI-SPEC, SPEC/);
});
