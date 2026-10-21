// gsd-pi — Blocker-placeholder recovery log coverage.
//
// writeBlockerPlaceholder writes a placeholder artifact so the pipeline can
// surface a stuck unit. Diagnostic placeholders never fabricate Task or Slice
// lifecycle authority. Plan-milestone records a durable recovery gate instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeBlockerPlaceholder, writeReactiveExecuteBlocker } from "../auto-recovery.ts";
import {
  closeDatabase,
  getTask,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

function makeBase(prefix = "gsd-blocker-logs-"): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  // Slice projection dirs so the placeholder path resolves.
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function captureLogs<T>(fn: () => T): { result: T; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = fn();
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

function recoveryWarnings(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((e) => e.component === "recovery" && e.severity === "warn");
}

test("writeBlockerPlaceholder never reads or changes Task authority", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // A diagnostic Task placeholder must not access the canonical tasks table.
    _getAdapter()!.exec("DROP TABLE tasks");

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "exhausted retries"),
    );

    assert.equal(recoveryWarnings(logs).length, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder never reads or changes Slice authority", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // A diagnostic complete-slice placeholder must not access the slices table.
    _getAdapter()!.exec("DROP TABLE slices");

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("complete-slice", "M001/S01", base, "exhausted retries"),
    );

    assert.equal(recoveryWarnings(logs).length, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder logs a recovery warning when the plan-milestone blocker gate cannot persist", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    _getAdapter()!.exec("DROP TABLE gate_runs");

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("plan-milestone", "M001", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) =>
      /planning blocker persistence failed for plan-milestone recovery/u.test(w.message),
    );
    assert.ok(warn, "a recovery warning must be logged when the durable blocker write throws");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder never appends Task lifecycle events", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Block the workflow-events append by turning its target into a directory
    // (appendFileSync on a directory throws EISDIR). The placeholder write still
    // succeeds because it targets a different path under milestones/.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "exhausted retries"),
    );

    assert.equal(recoveryWarnings(logs).length, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder never appends Slice lifecycle events", () => {
  const base = makeBase("gsd-blocker-logs-cs-");
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // A blocked compatibility event log must not matter because a diagnostic
    // complete-slice placeholder does not append lifecycle events.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("complete-slice", "M001/S01", base, "exhausted retries"),
    );

    assert.equal(recoveryWarnings(logs).length, 0);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder never appends plan-milestone lifecycle events", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-blocker-logs-pm-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "M", status: "active" });
    // If recovery still appends a lifecycle event, this path forces it to fail
    // and emit a warning. Durable planning blockers belong in gate_runs.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("plan-milestone", "M001", base, "exhausted retries"),
    );

    assert.equal(
      recoveryWarnings(logs).some((warning) => /appendEvent failed for plan-milestone recovery/u.test(warning.message)),
      false,
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeReactiveExecuteBlocker does not append lifecycle events from SUMMARY projections", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-blocker-logs-reactive-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "M", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "S", status: "active", risk: "low", depends: [], demo: "", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T1", status: "active" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T2", status: "active" });
    // T01 has a SUMMARY projection and T02 does not. Neither projection may
    // change canonical Task state or drive a workflow event.
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# T01\n", "utf-8");
    // If the diagnostic still tries to append a lifecycle event, this path
    // forces the append to fail and emit a recovery warning.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { result, logs } = captureLogs(() =>
      writeReactiveExecuteBlocker("M001/S01/reactive+T01,T02", base, "batch exhausted"),
    );

    assert.deepEqual(result?.completedTaskIds, []);
    assert.deepEqual(result?.skippedTaskIds, []);
    assert.deepEqual(result?.unchangedTaskIds, ["T01", "T02"]);
    assert.equal(getTask("M001", "S01", "T01")?.status, "active");
    assert.equal(getTask("M001", "S01", "T02")?.status, "active");
    assert.equal(
      recoveryWarnings(logs).some((warning) => /appendEvent failed for reactive/u.test(warning.message)),
      false,
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
