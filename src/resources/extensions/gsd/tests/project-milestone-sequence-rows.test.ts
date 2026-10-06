// Project/App: gsd-pi
// File Purpose: The Milestone Sequence of the PROJECT artifact is stored as rows (ADR-046).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { _getAdapter, closeDatabase, insertArtifact, openDatabase } from "../gsd-db.ts";
import { readProjectMilestoneSequence } from "../db/writers/project-milestone-sequence.ts";
import { markApprovalGateVerified, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";

function projectDocument(...milestoneLines: string[]): string {
  return ["# Project", "", "## Milestone Sequence", "", ...milestoneLines, ""].join("\n");
}

function setupBase(t: { after: (fn: () => void) => void }): string {
  const base = join(tmpdir(), `gsd-project-sequence-rows-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  markApprovalGateVerified("depth_verification_project_confirm", base);
  t.after(() => {
    clearDiscussionFlowState(base);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

async function saveProject(base: string, content: string) {
  const originalCwd = process.cwd();
  try {
    process.chdir(base);
    return await executeSummarySave({ artifact_type: "PROJECT", content }, base);
  } finally {
    process.chdir(originalCwd);
  }
}

test("the save of the PROJECT artifact stores its Milestone Sequence as rows", async (t) => {
  const base = setupBase(t);

  const saved = await saveProject(base, projectDocument(
    "- [ ] M001: Foundation — First runnable slice.",
    "- [ ] M002: Polish — Follow-up work.",
  ));
  assert.notEqual(saved.isError, true);
  assert.deepEqual(readProjectMilestoneSequence(_getAdapter()!), ["M001", "M002"]);

  invalidateStateCache();
  const state = await deriveStateFromDb(base);
  assert.equal(state.activeMilestone?.id, "M001", "the first milestone of the stored sequence is promoted");
});

test("a line that leaves the Milestone Sequence leaves the table in the same save", async (t) => {
  const base = setupBase(t);
  await saveProject(base, projectDocument(
    "- [ ] M001: Foundation — First runnable slice.",
    "- [ ] M002: Polish — Follow-up work.",
  ));

  const saved = await saveProject(base, projectDocument("- [ ] M002: Polish — Follow-up work."));
  assert.notEqual(saved.isError, true);
  assert.deepEqual(readProjectMilestoneSequence(_getAdapter()!), ["M002"]);

  invalidateStateCache();
  const state = await deriveStateFromDb(base);
  assert.equal(state.activeMilestone?.id, "M002", "M001 left the sequence, so it is not promoted");
});

test("a database that stored PROJECT before the table existed gets its rows on the next open", (t) => {
  const base = join(tmpdir(), `gsd-project-sequence-backfill-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const databasePath = join(base, ".gsd", "gsd.db");
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(databasePath);
  insertArtifact({
    path: "PROJECT.md",
    artifact_type: "PROJECT",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: projectDocument(
      "- [x] M001: Foundation — First runnable slice.",
      "- [ ] M002: Polish — Follow-up work.",
    ),
  });
  _getAdapter()!.exec("DROP TABLE project_milestone_sequence");
  closeDatabase();

  openDatabase(databasePath);
  assert.deepEqual(readProjectMilestoneSequence(_getAdapter()!), ["M001", "M002"]);
});
