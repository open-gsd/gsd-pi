// gsd-pi — Recovery artifact-verification log coverage.
//
// `verifyExpectedArtifact` is the gate that prevents an LLM from advancing the
// pipeline with a stub or incomplete artifact. Each verify-fail branch emits a
// `recovery` warning (or error) describing the exact reason — these logs are
// the operator's signal during stuck-loop diagnosis, so regressions that change
// or drop them must surface. The existing artifact-verification tests assert
// only the boolean return value; this file pins the log output for each
// important gate:
//   - plan-milestone roadmap has zero slices      (auto-recovery.ts:511)
//   - run-uat assessment missing a verdict        (auto-recovery.ts:502)
//   - validate-milestone validation not terminal  (auto-recovery.ts:494)
//   - generic verify-fail: artifact file missing  (auto-recovery.ts:487)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact, _setRoadmapParserFnForTests } from "../auto-recovery.ts";
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

test("plan-milestone verify-fail logs a recovery warning naming the zero-slice roadmap", () => {
  const base = createFixtureBase();
  try {
    const dir = milestoneDir(base, "M001");
    writeFileSync(join(dir, "M001-ROADMAP.md"), "# M001: Stub\n\n## Slices\n\n_TBD_\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("plan-milestone", "M001", base);

    assert.equal(result, false, "zero-slice roadmap must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail plan-milestone M001: roadmap has zero slices/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("run-uat verify-fail logs a recovery warning when the assessment has no verdict", () => {
  const base = createFixtureBase();
  try {
    const dir = sliceDir(base, "M001", "S01");
    // No `verdict:` frontmatter → hasVerdict() returns false → warning fires.
    writeFileSync(join(dir, "S01-ASSESSMENT.md"), "# UAT\n\nNo verdict yet.\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("run-uat", "M001/S01", base);

    assert.equal(result, false, "verdict-less assessment must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery entry must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail run-uat M001\/S01: assessment missing verdict/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validate-milestone verify-fail logs a recovery warning when the validation is not terminal", () => {
  const base = createFixtureBase();
  try {
    const dir = milestoneDir(base, "M001");
    // No `verdict:` → isValidationTerminal() returns false → warning fires.
    writeFileSync(join(dir, "M001-VALIDATION.md"), "# Validation\n\nStill in progress.\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("validate-milestone", "M001", base);

    assert.equal(result, false, "non-terminal validation must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail validate-milestone M001: validation not terminal/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("verify-fail logs a recovery warning when an expected artifact file is absent", () => {
  const base = createFixtureBase();
  try {
    // complete-slice resolves a SUMMARY path under the milestone dir, but we
    // never write the file → existsSync is false → the generic verify-fail path
    // logs and returns false.
    sliceDir(base, "M001", "S01");

    const { result, logs } = verifyAndCaptureLogs("complete-slice", "M001/S01", base);

    assert.equal(result, false, "missing artifact must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.equal(recovery!.severity, "warn");
    assert.match(recovery!.message, /verify-fail complete-slice M001\/S01: existsSync false/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a passing verification produces no recovery warnings", () => {
  const base = createFixtureBase();
  try {
    const dir = milestoneDir(base, "M001");
    writeFileSync(
      join(dir, "M001-ROADMAP.md"),
      ["# M001: Real roadmap", "", "## Slices", "", "- [ ] **S01: First slice** `risk:low` `depends:[]`", ""].join("\n"),
      "utf-8",
    );

    const { result, logs } = verifyAndCaptureLogs("plan-milestone", "M001", base);

    assert.equal(result, true, "a real roadmap must pass verification");
    assert.equal(
      findRecovery(logs),
      undefined,
      "no recovery warning should be logged on success",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── plan-slice verification gates (legacy path, no DB) ────────────────────
// These run the filesystem fallback when isDbAvailable() is false. Each verify-
// fail branch logs a recovery warning naming the exact missing artifact, so a
// regression that drops the reason would hide why a slice refused to advance.

test("plan-slice verify-fail logs a recovery warning when the plan has no task entries", () => {
  const base = createFixtureBase("gsd-recovery-logs-plan-");
  try {
    const dir = sliceDir(base, "M001", "S01");
    // A PLAN with neither a `- [ ] **T0x:**` checkbox nor a `## T0x --` heading.
    writeFileSync(join(dir, "S01-PLAN.md"), "# S01: Stub\n\n## Tasks\n\n_TBD_\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("plan-slice", "M001/S01", base);

    assert.equal(result, false, "a task-less plan must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail plan-slice M001\/S01: plan has no task checkbox\/heading/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plan-slice verify-fail logs a recovery warning when the tasks dir is missing", () => {
  const base = createFixtureBase("gsd-recovery-logs-tasksdir-");
  try {
    const dir = sliceDir(base, "M001", "S01");
    // Valid checkbox task, but we deliberately do NOT create the tasks/ dir.
    writeFileSync(
      join(dir, "S01-PLAN.md"),
      "# S01: Has task\n\n## Tasks\n\n- [ ] **T01: A** `est:15m`\n",
      "utf-8",
    );

    const { result, logs } = verifyAndCaptureLogs("plan-slice", "M001/S01", base);

    assert.equal(result, false, "a plan without its tasks dir must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail plan-slice M001\/S01: tasks dir missing/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plan-slice verify-fail logs a recovery warning when an individual task artifact is missing", () => {
  const base = createFixtureBase("gsd-recovery-logs-taskplan-");
  try {
    const dir = sliceDir(base, "M001", "S01");
    writeFileSync(
      join(dir, "S01-PLAN.md"),
      "# S01: Has task\n\n## Tasks\n\n- [ ] **T01: A** `est:15m`\n",
      "utf-8",
    );
    // Create the tasks dir but NOT any T01 task artifact inside it.
    mkdirSync(join(dir, "tasks"), { recursive: true });

    const { result, logs } = verifyAndCaptureLogs("plan-slice", "M001/S01", base);

    assert.equal(result, false, "a missing task artifact must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail plan-slice M001\/S01: task artifact missing for T01/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── parallel-research sentinel verification gates ─────────────────────────
// The "{mid}/parallel-research" sentinel fans research across multiple slices.
// verifyExpectedArtifact checks every research-ready slice has a RESEARCH file;
// each failure logs a recovery warning naming the exact gap.

test("parallel-research verify-fail logs a recovery warning when the roadmap is missing", () => {
  const base = createFixtureBase("gsd-recovery-logs-prr-");
  try {
    // No roadmap file present → resolveExpectedArtifactPath("plan-milestone")
    // returns null/missing → :445 warning.
    const { result, logs } = verifyAndCaptureLogs("research-slice", "M001/parallel-research", base);

    assert.equal(result, false, "missing roadmap must fail parallel-research verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail research-slice M001\/parallel-research: roadmap missing/u,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parallel-research verify-fail logs a recovery warning when a research-ready slice lacks RESEARCH", () => {
  const base = createFixtureBase("gsd-recovery-logs-prrs-");
  try {
    const dir = milestoneDir(base, "M001");
    // The roadmap projection must exist so verification passes the
    // roadmap-missing guard; slice state itself comes from the DB (ADR-017).
    writeFileSync(
      join(dir, "M001-ROADMAP.md"),
      ["# M001: Roadmap", "", "## Slices", "", "- [ ] **S01: First** `risk:low` `depends:[]`", ""].join("\n"),
      "utf-8",
    );
    // One not-done slice (S01) and no milestone-level RESEARCH: S01 is
    // research-ready (no deps, not done) and has no RESEARCH file.
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Roadmap", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "First", status: "pending", risk: "low", depends: [] });

    const { result, logs } = verifyAndCaptureLogs("research-slice", "M001/parallel-research", base);

    assert.equal(result, false, "a research-ready slice without RESEARCH must fail verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(
      recovery!.message,
      /verify-fail research-slice M001\/parallel-research: slice S01 missing RESEARCH/u,
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
// plan-milestone parses the artifact's own content (does it declare slices?),
// so its parse-failure catch survives the DB cutover; parseProjectionRoadmap is
// internally defensive against every malformed input, so that catch is
// unreachable without the _setRoadmapParserFnForTests seam.
// complete-slice and parallel-research instead read slice state from the DB.
// With no DB they must fail CLOSED — never silently return true — and say why.

test("plan-milestone verify logs a recovery warning when the roadmap parser throws (auto-recovery.ts:515)", () => {
  const base = createFixtureBase("gsd-recovery-logs-parse-");
  const restore = _setRoadmapParserFnForTests(() => {
    throw new Error("forced roadmap parse failure");
  });
  try {
    const dir = milestoneDir(base, "M001");
    // A real ROADMAP file must exist so verification reaches the parser.
    writeFileSync(join(dir, "M001-ROADMAP.md"), "# M001: x\n\n## Slices\n\n- [ ] **S01: A**\n", "utf-8");

    const { result, logs } = verifyAndCaptureLogs("plan-milestone", "M001", base);

    assert.equal(result, false, "a parser failure must fail plan-milestone verification");
    const recovery = findRecovery(logs);
    assert.ok(recovery, "a recovery warning must be logged");
    assert.match(recovery!.message, /plan-milestone roadmap verification failed/u);
    assert.match(recovery!.message, /forced roadmap parse failure/u);
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("complete-slice verify fails closed and logs a recovery warning when the DB is unavailable", () => {
  const base = createFixtureBase("gsd-recovery-logs-cs-parse-");
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
    assert.match(recovery!.message, /cannot confirm slice completion/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parallel-research verify fails closed and logs a recovery warning when the DB is unavailable", () => {
  const base = createFixtureBase("gsd-recovery-logs-prr-throw-");
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
    assert.match(recovery!.message, /cannot verify slice RESEARCH coverage/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("execute-task verify fails closed and logs a recovery warning when the DB is unavailable", () => {
  const base = createFixtureBase("gsd-recovery-logs-et-nodb-");
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
    assert.match(recovery!.message, /cannot confirm task completion/u);
  } finally {
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
    rmSync(base, { recursive: true, force: true });
  }
});
