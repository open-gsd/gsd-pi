// gsd-pi — Dispatch reactive graph derivation log coverage.
//
// The "executing → reactive-execute" rule wraps its graph derivation in a
// best-effort catch (auto-dispatch.ts:1492-1496) that logs a `dispatch` ERROR
// "reactive graph derivation failed" and falls through to sequential execution.
// The catch is otherwise unreachable because every operation it wraps
// (loadSliceTaskIO, deriveTaskGraph, saveReactiveState) is internally
// defensive — so we inject a throwing derive function via the sanctioned
// setReactiveGraphDeriveFnForTest seam (mirroring the :1809 / :637 pattern) to
// deterministically exercise the failure path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveDispatch,
  DISPATCH_RULES,
  setReactiveGraphDeriveFnForTest,
  type DispatchContext,
} from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { convertDispatchRules, initRegistry, getRegistry, resetRegistry } from "../rule-registry.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

function makeExecutingCtx(base: string): DispatchContext {
  return {
    basePath: base,
    mid: "M001",
    midTitle: "Milestone",
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Milestone", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      activeTask: { id: "T01", title: "Task" },
      registry: [],
      blockers: [],
    } as unknown as GSDState,
    // Explicit opt-in keeps the legacy min-ready threshold (2) and ensures the
    // rule proceeds past the enabled/maxParallel guards into the derivation try.
    prefs: { reactive_execution: { enabled: true, max_parallel: 2 } } as DispatchContext["prefs"],
  };
}

test("reactive rule logs a dispatch error when graph derivation throws (auto-dispatch.ts:1494)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-reactive-logs-"));
  // Minimal slice projection so the rule's earlier filesystem guards resolve.
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01\n\n## Tasks\n\n- [ ] **T01: A**\n", "utf-8");
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

  // Snapshot + initialize the registry so resolveDispatch uses the inline rules.
  let previousExists = false;
  try { getRegistry(); previousExists = true; } catch { previousExists = false; }
  initRegistry(convertDispatchRules(DISPATCH_RULES));

  // Inject a throwing derive fn so the rule's try block (auto-dispatch.ts:1414+)
  // throws before any defensive operation, hitting the :1494 catch.
  const restoreDerive = setReactiveGraphDeriveFnForTest(async () => {
    throw new Error("forced graph derivation failure");
  });

  const previousStderr = setStderrLoggingEnabled(false);
  _resetLogs();
  let logs: LogEntry[] = [];
  try {
    // resolveDispatch must NOT throw — the rule catches the derivation failure
    // and falls through to sequential execution.
    await resolveDispatch(makeExecutingCtx(base));
    logs = drainLogs();
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previousStderr);
    restoreDerive();
    initRegistry(convertDispatchRules(DISPATCH_RULES));
    if (!previousExists) resetRegistry();
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
    void t;
  }

  const err = logs.find(
    (e) => e.component === "dispatch" && e.severity === "error" && /reactive graph derivation failed/u.test(e.message),
  );
  assert.ok(
    err,
    "a dispatch ERROR must be logged when reactive graph derivation fails (got: " +
      logs.filter((e) => e.component === "dispatch").map((e) => e.message).join(" | ") + ")",
  );
  assert.equal(err!.message, "reactive graph derivation failed");
  assert.match(err!.context?.error ?? "", /forced graph derivation failure/u);
});
