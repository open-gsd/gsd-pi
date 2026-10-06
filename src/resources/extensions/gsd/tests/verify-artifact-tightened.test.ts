/**
 * verifyExpectedArtifact behaviour after the DB cutover (ADR-017).
 *
 * Task completion is DB-authoritative: for `execute-task`, verification reads
 * the latest Task Attempt and nothing else. There is no longer a legacy branch
 * that reads a slice PLAN — with the DB open the Attempt decides, and with the
 * DB unavailable the unit fails closed. The #3607 checkbox-discrimination
 * tests that used to live here were retired for that reason (see
 * `docs/dev/state-db-cutover-milestone-decision.md`); a test that asserts
 * against an unreachable branch reads as protection that does not exist.
 *
 * What remains here:
 * - `execute-task` fails closed with a `recovery` warning when the DB is
 *   unavailable, and does not accept projection evidence when the DB is open
 *   but carries no settled Attempt Result.
 *
 * No unit type resolves a file to verify any more: the sibling/team-suffix
 * phase-dir lookup (#1500) and the worktree→project-root fallback (#852, #870)
 * were removed with the file checks. tests/completion-evidence-db-rows.test.ts
 * holds the per-unit-type DB evidence gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { drainLogs, setStderrLoggingEnabled, _resetLogs, type LogEntry } from "../workflow-logger.ts";

/**
 * Run `verifyExpectedArtifact` with stderr suppressed, returning both the
 * result and the log entries the call emitted. The workflow-logger buffer is a
 * process-wide singleton, so it must be drained inside this scope.
 */
function verifyAndCaptureLogs(
  unitType: string,
  unitId: string,
  base: string,
): { result: boolean; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = verifyExpectedArtifact(unitType, unitId, base);
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

/** Scaffold .gsd/milestones/M001/slices/S01/ with tasks/ and a T01-SUMMARY.md. */
function scaffoldProject(t: { after: (fn: () => void) => void }): {
  base: string;
  planPath: string;
} {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-artifact-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  // Summary file must exist so verifyExpectedArtifact reaches the legacy branch
  writeFileSync(join(sliceDir, "tasks", "T01-SUMMARY.md"), "# T01 summary\n");
  return { base, planPath: join(sliceDir, "S01-PLAN.md") };
}

test("execute-task with the DB unavailable — checked checkbox [x] fails closed", (t) => {
  closeDatabase();
  assert.equal(isDbAvailable(), false, "DB must be closed to exercise the DB-unavailable path");

  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
      "",
    ].join("\n"),
  );

  const { result, logs } = verifyAndCaptureLogs("execute-task", "M001/S01/T01", base);

  assert.equal(
    result,
    false,
    "a checked checkbox is a projection, not authority — it must not verify completion",
  );
  const recovery = logs.find((e) => e.component === "recovery" && /verify-fail execute-task M001\/S01\/T01/u.test(e.message));
  assert.ok(recovery, "a recovery warning must name why completion could not be confirmed");
  assert.match(recovery!.message, /DB unavailable/u);
  assert.match(recovery!.message, /cannot verify unit artifact/u);
});

test("execute-task with the DB unavailable — checked checkbox [X] (uppercase) also fails closed", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [X] **T01: Implement feature**",
    ].join("\n"),
  );

  const { result, logs } = verifyAndCaptureLogs("execute-task", "M001/S01/T01", base);

  assert.equal(result, false, "uppercase [X] is no more authoritative than lowercase [x]");
  const recovery = logs.find((e) => e.component === "recovery" && /verify-fail execute-task M001\/S01\/T01/u.test(e.message));
  assert.ok(recovery, "a recovery warning must be logged");
  assert.match(recovery!.message, /DB unavailable/u);
});

// The four #3607 negatives that stood here (unchecked `[ ]`, bare heading,
// missing plan, wrong task id) were deleted by T036. Each opened
// `closeDatabase()` and asserted `false`, but DB-closed `execute-task`
// verification now returns `false` unconditionally, so no fixture could make
// them fail. Checkbox discrimination is not a behaviour this codebase has any
// more; see the milestone decision doc's accepted residual risks.

test("execute-task DB branch ignores checked plan and summary without an Attempt Result", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(isDbAvailable(), true, "DB must be open to hit the DB-lag branch");

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });

  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "DB-backed verification must not accept projection evidence without an Attempt Result",
  );
});

test("execute-task DB branch ignores legacy complete Task status without an Attempt Result", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "complete" });
  writeFileSync(planPath, "- [x] **T01: Implement feature**\n");

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "legacy Task completion and projections cannot replace canonical Attempt readiness",
  );
});

test("execute-task DB lag branch — summary without checked plan still fails", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  openDatabase(join(base, ".gsd", "gsd.db"));

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Implement feature", status: "pending" });

  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "pending DB status plus summary is insufficient without a checked task checkbox",
  );
});
