// gsd-pi — Recovery artifact-verification log coverage.
//
// `verifyExpectedArtifact` is the gate that prevents an LLM from advancing the
// pipeline with a stub or incomplete artifact. Each verify-fail branch emits a
// `recovery` warning (or error) describing the exact reason — these logs are
// the operator's signal during stuck-loop diagnosis, so regressions that change
// or drop them must surface. The existing artifact-verification tests assert
// only the boolean return value; this file pins the log output for each
// important gate:
//   - plan-milestone: the milestone has no slice rows
//   - run-uat: no run-uat verdict row
//   - complete-slice: the slice row is not complete
//   - plan-slice: the slice has no task rows
// Each case also writes the unit's projection file, well formed: the file
// must not change the result (ADR-046).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { closeDatabase, openDatabase, insertMilestone, insertSlice, _getAdapter } from "../gsd-db.ts";
import {
  drainLogs,
  peekLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

function createFixtureBase(prefix = "gsd-recovery-logs-"): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  // Milestone-scoped verification needs an open DB (ADR-046).
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function milestoneDir(base: string, mid: string): string {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sliceDir(base: string, mid: string, sid: string): string {
  const dir = join(base, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run `verifyExpectedArtifact` with stderr suppressed and capture both the
 * return value and the log entries emitted by the call. The log buffer is
 * reset before the call (so no bleed from prior tests) and drained inside the
 * capture scope (before the finally clears it) so callers can assert on logs
 * after the helper returns.
 *
 * NOTE: the workflow-logger `_buffer` is a process-wide singleton shared with
 * the code under test, so we must drain inside this scope — reading it after
 * the finally would see an already-cleared buffer.
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

function findRecovery(logs: readonly LogEntry[]): LogEntry | undefined {
  return logs.find((e) => e.component === "recovery");
}

test("plan-milestone verify-fail logs a recovery warning naming the missing slice rows", () => {
  const base = createFixtureBase();
  try {
    insertMilestone({ id: "M001", title: "Stub", status: "active" });
    const dir = milestoneDir(base, "M001");
    // A roadmap file that lists a slice does not stand in for the slice rows.
    writeFileSync(
      join(dir, "M001-ROADMAP.md"),
      ["# M001: Stub", "", "## Slices", "", "- [ ] **S01: First slice** `risk:low` `depends:[]`", ""].join("\n"),
      "utf-8",
    );

    const { result, logs } = verifyAndCaptureLogs("plan-milestone", "M001", base);

    assert.equal(result, false, "a milestone with no slice rows must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail plan-milestone M001: the milestone has no slice rows/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("run-uat verify-fail logs a recovery warning when no run-uat verdict row exists", () => {
  const base = createFixtureBase();
  try {
    insertMilestone({ id: "M001", title: "Roadmap", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "First", status: "complete", risk: "low", depends: [] });
    const dir = sliceDir(base, "M001", "S01");
    // A PASS verdict in the file is not a recorded verdict.
    writeFileSync(join(dir, "S01-ASSESSMENT.md"), "---\nverdict: PASS\n---\n\n# UAT\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("run-uat", "M001/S01", base);

    assert.equal(result, false, "an assessment file with no run-uat row must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery entry must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail run-uat M001\/S01: no run-uat verdict row/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("complete-slice verify-fail logs a recovery warning naming the slice row status", () => {
  const base = createFixtureBase();
  try {
    insertMilestone({ id: "M001", title: "Roadmap", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "First", status: "active", risk: "low", depends: [] });
    const dir = sliceDir(base, "M001", "S01");
    writeFileSync(join(dir, "S01-SUMMARY.md"), "# S01 done\n", "utf-8");
    writeFileSync(join(dir, "S01-UAT.md"), "# UAT\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("complete-slice", "M001/S01", base);

    assert.equal(result, false, "SUMMARY and UAT files must not verify an open slice");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail complete-slice M001\/S01: the slice row is "active"/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("a passing verification produces no recovery warnings", () => {
  const base = createFixtureBase();
  try {
    insertMilestone({ id: "M001", title: "Real roadmap", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "First slice", status: "pending", risk: "low", depends: [] });

    const { result, logs } = verifyAndCaptureLogs("plan-milestone", "M001", base);

    assert.equal(result, true, "a milestone with slice rows must pass verification");
    assert.equal(
      findRecovery(logs),
      undefined,
      "no recovery warning should be logged on success",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── plan-slice verification gate ──────────────────────────────────────────
// The verify-fail branch logs a recovery warning naming the missing rows, so a
// regression that drops the reason would hide why a slice refused to advance.

test("plan-slice verify-fail logs a recovery warning when the slice has no task rows", () => {
  const base = createFixtureBase("gsd-recovery-logs-plan-");
  try {
    insertMilestone({ id: "M001", title: "Roadmap", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "First", status: "pending", risk: "low", depends: [] });
    const dir = sliceDir(base, "M001", "S01");
    // A PLAN file with a task entry and its task plan do not stand in for task rows.
    writeFileSync(join(dir, "S01-PLAN.md"), "# S01: Has task\n\n## Tasks\n\n- [ ] **T01: A** `est:15m`\n", "utf-8");
    mkdirSync(join(dir, "tasks"), { recursive: true });
    writeFileSync(join(dir, "tasks", "T01-PLAN.md"), "# T01: A\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("plan-slice", "M001/S01", base);

    assert.equal(result, false, "a slice with no task rows must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail plan-slice M001\/S01: the slice has no task rows/u,
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── parallel-research sentinel verification gates ─────────────────────────
// The "{mid}/parallel-research" sentinel fans research across multiple slices.
// verifyExpectedArtifact checks every research-ready slice has a saved RESEARCH
// row; a failure logs a recovery warning naming the exact gap.

test("parallel-research verify-fail logs a recovery warning when a research-ready slice lacks RESEARCH", () => {
  const base = createFixtureBase("gsd-recovery-logs-prrs-");
  try {
    // One not-done slice (S01) and no milestone-level RESEARCH: S01 is
    // research-ready (no deps, not done) and has no saved RESEARCH row. A
    // RESEARCH file on disk does not change that.
    insertMilestone({ id: "M001", title: "Roadmap", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "First", status: "pending", risk: "low", depends: [] });
    writeFileSync(join(sliceDir(base, "M001", "S01"), "S01-RESEARCH.md"), "# research\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("research-slice", "M001/parallel-research", base);

    assert.equal(result, false, "a research-ready slice without saved RESEARCH must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail research-slice M001\/parallel-research: slice S01 has no saved RESEARCH/u,
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── gate-evaluate DB-degradation gate ─────────────────────────────────────
// gate-evaluate verifies dispatched gates are no longer pending via a DB query.
// When the DB is available but the query throws (e.g. quality_gates table
// missing), the catch (auto-recovery.ts:411) logs a recovery warning and treats
// the unit as verified to avoid blocking. This pins that degradation log.

test("gate-evaluate verify logs a recovery warning when the pending-gates DB query throws", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-recovery-logs-gate-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    // Open a DB then drop quality_gates so getPendingGatesForTurn throws inside
    // the gate-evaluate DB branch → :411 warning. (getGateIdsForTurn returns
    // default gate-evaluate ids, so the query path is reached.)
    openDatabase(join(base, ".gsd", "gsd.db"));
    _getAdapter()!.exec("DROP TABLE quality_gates");

    const previous = setStderrLoggingEnabled(false);
    _resetLogs();
    let result: boolean;
    try {
      // Batch unitId "M001/S01/gates+Q3" encodes one dispatched gate.
      result = verifyExpectedArtifact("gate-evaluate", "M001/S01/gates+Q3", base);
      const logs = drainLogs();
      const recovery = logs.find((e) => e.component === "recovery" && /gate-evaluate DB check failed/u.test(e.message));
      assert.ok(recovery, "a recovery warning must be logged when the gate DB check throws");
      assert.match(recovery!.message, /gate-evaluate DB check failed/u);
    } finally {
      _resetLogs();
      setStderrLoggingEnabled(previous);
    }
    // Per :411 comment, a DB failure is treated as verified (return true) to
    // avoid blocking the loop — pin that resilience contract too.
    assert.equal(result, true, "a gate-evaluate DB failure must not block verification");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── fail-closed verification witnesses ────────────────────────────────────
// Unit results are read from the DB. With no DB, or when the read throws, the
// check must fail CLOSED — never silently return true — and say why.

test("discuss-milestone verify fails closed and logs a recovery warning when the DB read throws", () => {
  const base = createFixtureBase("gsd-recovery-logs-read-");
  try {
    insertMilestone({ id: "M001", title: "Roadmap", status: "active" });
    const dir = milestoneDir(base, "M001");
    writeFileSync(join(dir, "M001-CONTEXT.md"), "# Context\n\nDecisions.\n", "utf-8");
    // The saved-artifact read throws: the CONTEXT file must not rescue it.
    _getAdapter()!.exec("DROP TABLE artifacts");

    const { result, logs } = verifyAndCaptureLogs("discuss-milestone", "M001", base);

    assert.equal(result, false, "a failed DB read must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(recovery!.message, /verify-fail discuss-milestone M001: DB read failed/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("complete-slice verify fails closed and logs a recovery warning when the DB is unavailable", () => {
  const base = createFixtureBase("gsd-recovery-logs-cs-parse-");
  closeDatabase();
  try {
    const dir = sliceDir(base, "M001", "S01");
    // complete-slice verification: SUMMARY + UAT present, but this fixture base
    // carries no gsd.db, so the slice row cannot be read. Slice completion is
    // DB-authoritative (ADR-017) — the artifacts alone must NOT verify.
    writeFileSync(join(dir, "S01-SUMMARY.md"), "# S01 done\n", "utf-8");
    // UAT file required so the complete-slice guard does not return false
    // before reaching the DB read.
    writeFileSync(join(dir, "S01-UAT.md"), "# UAT\n", "utf-8");
    // A roadmap projection marking S01 not-done must not be consulted at all.
    writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), "# M001\n\n## Slices\n\n- [ ] **S01: A**\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("complete-slice", "M001/S01", base);

    assert.equal(result, false, "an unreadable slice row must fail complete-slice verification");
    const recovery = logs.find((e) => e.component === "recovery" && /verify-fail complete-slice M001\/S01/u.test(e.message));
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(recovery!.message, /DB unavailable/u);
    assert.match(recovery!.message, /cannot verify unit artifact/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("parallel-research verify fails closed and logs a recovery warning when the DB is unavailable", () => {
  const base = createFixtureBase("gsd-recovery-logs-prr-throw-");
  closeDatabase();
  try {
    const dir = milestoneDir(base, "M001");
    // A real ROADMAP so verification clears the roadmap-missing guard, but this
    // fixture base carries no gsd.db. Slice state is DB-authoritative
    // (ADR-017): an empty slice list must not read as "every slice researched".
    writeFileSync(
      join(dir, "M001-ROADMAP.md"),
      ["# M001: Roadmap", "", "## Slices", "", "- [ ] **S01: First** `risk:low` `depends:[]`", ""].join("\n"),
      "utf-8",
    );

    const { result, logs } = verifyAndCaptureLogs("research-slice", "M001/parallel-research", base);

    assert.equal(result, false, "an unreadable slice list must fail parallel-research verification");
    const recovery = logs.find((e) => e.component === "recovery" && /verify-fail research-slice M001\/parallel-research/u.test(e.message));
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(recovery!.message, /DB unavailable/u);
    assert.match(recovery!.message, /cannot verify unit artifact/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("execute-task verify fails closed and logs a recovery warning when the DB is unavailable", () => {
  const base = createFixtureBase("gsd-recovery-logs-et-nodb-");
  closeDatabase();
  try {
    const dir = sliceDir(base, "M001", "S01");
    mkdirSync(join(dir, "tasks"), { recursive: true });
    // A PLAN projection that ticks T01 as done, plus the task SUMMARY the
    // generic artifact check looks for. Task completion is DB-authoritative
    // (ADR-017): with no gsd.db under this fixture base, a `- [x] **T01:`
    // checkbox must NOT be accepted as proof of completion.
    writeFileSync(
      join(dir, "S01-PLAN.md"),
      "# S01: Test Slice\n\n## Tasks\n\n- [x] **T01: Implement feature** `est:15m`\n",
      "utf-8",
    );
    writeFileSync(join(dir, "tasks", "T01-SUMMARY.md"), "# T01 Summary\n\nDone.\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("execute-task", "M001/S01/T01", base);

    assert.equal(result, false, "a checked PLAN checkbox must not verify task completion without the DB");
    const recovery = logs.find((e) => e.component === "recovery" && /verify-fail execute-task M001\/S01\/T01/u.test(e.message));
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /DB unavailable/u);
    assert.match(recovery!.message, /cannot verify unit artifact/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("complete-milestone verify fails closed and logs a recovery warning when the closeout proof fails", () => {
  const base = createFixtureBase("gsd-recovery-logs-cm-nodb-");
  try {
    const dir = milestoneDir(base, "M001");
    // A success-looking SUMMARY, but no gsd.db under this fixture base, so
    // proveMilestoneCloseout cannot clear the closeout consistency gate.
    // Milestone closeout is DB-authoritative (ADR-017): SUMMARY content must
    // never rescue a failed closeout proof into a verify-pass.
    writeFileSync(join(dir, "M001-SUMMARY.md"), "# M001: Milestone Summary\n\nDone.\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("complete-milestone", "M001", base);

    assert.equal(result, false, "a failed closeout proof must stay failed");
    const recovery = logs.find((e) => e.component === "recovery" && /verify-fail complete-milestone M001/u.test(e.message));
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /closeout proof failed/u);
    assert.match(recovery!.message, /cannot confirm milestone closeout/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
