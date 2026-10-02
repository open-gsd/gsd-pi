// Project/App: gsd-pi
// File Purpose: Proves every slice reader gives the same closed/open answer for each raw status.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkCloseoutConsistencyGate } from "../closeout-consistency-gate.ts";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import {
  _getAdapter,
  closeDatabase,
  getMilestoneSlices,
  insertArtifact,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { getEligibleSlicesFromRows } from "../slice-parallel-eligibility.ts";
import { deriveStateFromDb, getActiveMilestoneId, invalidateStateCache } from "../state.ts";
import { appendEvent } from "../workflow-events.ts";

// The expected answer is stated here, independent of any predicate under test.
const RAW_STATUS_TABLE: ReadonlyArray<readonly [status: string, closed: boolean]> = [
  ["complete", true],
  ["done", true],
  ["closed", true],
  ["skipped", true],
  ["cancelled", true],
  ["blocker-accepted", true],
  ["deferred", true],
  ["pending", false],
  ["queued", false],
  ["planned", false],
  ["active", false],
  ["in_progress", false],
  ["in-progress", false],
  ["blocked", false],
];

for (const [status, closed] of RAW_STATUS_TABLE) {
  test(`slice status "${status}" is ${closed ? "closed" : "open"} for every reader`, async (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-status-vocabulary-"));
    const gsdDir = join(base, ".gsd");
    const sliceDir = join(gsdDir, "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    openDatabase(join(gsdDir, "gsd.db"));
    t.after(() => {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    });

    // M001: the slice under test, then a pending slice that waits on it by position.
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Under test", status, risk: "low", depends: [], sequence: 1 });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Next", status: "pending", risk: "low", depends: [], sequence: 2 });
    // A SUMMARY for S01: doctor reports it when the DB still says S01 is open.
    const summaryPath = "milestones/M001/slices/S01/S01-SUMMARY.md";
    writeFileSync(join(gsdDir, summaryPath), "# S01 summary\n", "utf-8");
    insertArtifact({
      path: summaryPath,
      artifact_type: "SUMMARY",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: null,
      full_content: "# S01 summary\n",
    });
    // M900: a closed milestone whose only slice is the status under test, so
    // the closeout gate's verdict depends on that slice alone.
    insertMilestone({ id: "M900", title: "Closeout", status: "skipped" });
    insertSlice({ id: "S01", milestoneId: "M900", title: "Under test", status, risk: "low", depends: [], sequence: 1 });

    invalidateStateCache();
    const state = await deriveStateFromDb(base);
    assert.equal(state.activeSlice?.id, closed ? "S02" : "S01", "deriveState active slice");

    const blocker = getPriorSliceCompletionBlocker(base, "main", "plan-slice", "M001/S02");
    assert.equal(blocker === null, closed, `dispatch guard: ${blocker}`);

    assert.deepEqual(
      getEligibleSlicesFromRows(getMilestoneSlices("M001")).map((slice) => slice.id),
      [closed ? "S02" : "S01"],
      "slice-parallel eligibility",
    );

    const closeout = checkCloseoutConsistencyGate("M900");
    assert.equal(closeout.ok, closed, `closeout gate: ${closeout.ok ? "ok" : closeout.message}`);
    if (!closeout.ok) assert.equal(closeout.reason, "slice-open");

    const issues: Array<{ code: string; unitId?: string }> = [];
    await checkEngineHealth(base, issues as never[], []);
    assert.equal(
      issues.some((issue) => issue.code === "artifact_db_status_divergence" && issue.unitId === "M001/S01"),
      !closed,
      "doctor reports a completion artifact only for an open slice",
    );
  });
}

// Doctor asks "was this completed milestone reopened?" with the same closed
// set as every other reader: a cancelled or blocker-accepted milestone is not
// an open one.
for (const [status, closed] of [
  ["complete", true],
  ["skipped", true],
  ["cancelled", true],
  ["blocker-accepted", true],
  ["active", false],
] as const) {
  test(`doctor treats milestone status "${status}" as ${closed ? "closed" : "reopened"}`, async (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-status-vocabulary-doctor-"));
    const gsdDir = join(base, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    openDatabase(join(gsdDir, "gsd.db"));
    t.after(() => {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    });

    insertMilestone({ id: "M001", title: "Completed once", status });
    const db = _getAdapter()!;
    db.prepare(
      `INSERT INTO workers (
        worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("worker-1", "localhost", 1, "2026-01-01T00:00:00.000Z", "test", "2026-01-01T00:00:00.000Z", "stopped", base);
    db.prepare(
      `INSERT INTO unit_dispatches (
        trace_id, worker_id, milestone_lease_token, milestone_id,
        unit_type, unit_id, status, attempt_n, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "trace-1", "worker-1", 1, "M001", "complete-milestone", "M001", "completed", 1,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z",
    );
    appendEvent(base, {
      cmd: "complete-milestone",
      params: { milestoneId: "M001" },
      ts: "2026-01-01T00:00:00.500Z",
      actor: "agent",
    });

    const issues: Array<{ code: string }> = [];
    await checkEngineHealth(base, issues as never[], []);
    assert.equal(issues.some((issue) => issue.code === "completed_milestone_reopened"), !closed);
  });
}

test("getActiveMilestoneId follows deriveState, including the dependency rule", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-status-vocabulary-active-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // M001 is first in order but waits on M002, so it is not the active milestone.
  insertMilestone({ id: "M001", title: "Waits on M002", status: "active", depends_on: ["M002"] });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertMilestone({ id: "M002", title: "Runs first", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });

  invalidateStateCache();
  const state = await deriveStateFromDb(base);
  assert.equal(state.activeMilestone?.id, "M002");
  invalidateStateCache();
  assert.equal(await getActiveMilestoneId(base), state.activeMilestone?.id);
});
