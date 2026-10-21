// Project/App: gsd-pi
// File Purpose: Generic Task status writes cannot bypass the semantic reopen operation.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  updateTaskStatus,
} from "../gsd-db.ts";

const tempDirs = new Set<string>();

function openFixture(status: string): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-status-guard-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Guard", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Guard", status: "active" });
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Guarded task",
    status,
  });
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("generic Task status writes reject closed-to-open transitions", () => {
  for (const closedStatus of ["complete", "done", "skipped", "closed"]) {
    openFixture(closedStatus);

    assert.throws(
      () => updateTaskStatus("M001", "S01", "T01", "pending"),
      /closed task.*gsd_task_reopen/i,
    );
    assert.equal(getTask("M001", "S01", "T01")?.status, closedStatus);
    closeDatabase();
  }
});

test("generic Task status writes preserve non-reopen transitions", () => {
  openFixture("pending");

  updateTaskStatus("M001", "S01", "T01", "in_progress");
  assert.equal(getTask("M001", "S01", "T01")?.status, "in_progress");

  updateTaskStatus("M001", "S01", "T01", "complete");
  assert.equal(getTask("M001", "S01", "T01")?.status, "complete");

  updateTaskStatus("M001", "S01", "T01", "skipped");
  assert.equal(getTask("M001", "S01", "T01")?.status, "skipped");
});
