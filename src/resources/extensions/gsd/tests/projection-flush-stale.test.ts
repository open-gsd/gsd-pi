// Project/App: gsd-pi
// File Purpose: Projection flush delivery diagnostics remain visible to mutation callers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
  reopenMilestoneCascade,
} from "../gsd-db.ts";
import {
  _setProjectionFlushAfterRenderForTest,
  flushWorkflowProjections,
} from "../projection-flush.ts";
import { renderAllProjections } from "../workflow-projections.ts";

test("projection flush reports a swallowed readable-state obstruction as stale", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-flush-stale-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Projection delivery", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Report stale projections",
    status: "active",
  });
  mkdirSync(join(base, ".gsd", "STATE.md"));

  assert.deepEqual(await renderAllProjections(base, "M001"), { stale: true });
  assert.deepEqual(await flushWorkflowProjections(base, { milestoneId: "M001" }), {
    milestoneId: "M001",
    stale: true,
    superseded: false,
  });
});

test("projection flush skips work when its operation fence is already superseded", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-flush-superseded-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await flushWorkflowProjections(base, { milestoneId: "M001" }, {
    operationId: "operation-1",
    isCurrent: () => false,
  });

  assert.deepEqual(result, {
    milestoneId: "M001",
    stale: false,
    superseded: true,
  });
});

test("projection flush reports uncertain output when its fence is lost during rendering", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-flush-race-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Projection delivery", status: "active" });

  let currentnessChecks = 0;
  const result = await flushWorkflowProjections(base, { milestoneId: "M001" }, {
    operationId: "operation-1",
    isCurrent: () => ++currentnessChecks === 1,
  });

  assert.equal(currentnessChecks, 2);
  assert.deepEqual(result, {
    milestoneId: "M001",
    stale: true,
    superseded: true,
  });
});

test("superseded projection flush repairs shell output from current DB state", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-projection-flush-current-repair-"));
  t.after(() => {
    _setProjectionFlushAfterRenderForTest(null);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Projection delivery", status: "complete" });

  let current = true;
  _setProjectionFlushAfterRenderForTest(() => {
    _setProjectionFlushAfterRenderForTest(null);
    assert.equal(reopenMilestoneCascade("M001").ok, true);
    current = false;
  });

  const result = await flushWorkflowProjections(base, { milestoneId: "M001" }, {
    operationId: "operation-1",
    isCurrent: () => current,
  });

  assert.deepEqual(result, {
    milestoneId: "M001",
    stale: true,
    superseded: true,
  });
  const roadmap = readFileSync(join(base, ".gsd", "ROADMAP.md"), "utf8");
  assert.match(roadmap, /🔄 \*\*M001: Projection delivery\*\*/);
  assert.doesNotMatch(roadmap, /✅ \*\*M001: Projection delivery\*\*/);
});
