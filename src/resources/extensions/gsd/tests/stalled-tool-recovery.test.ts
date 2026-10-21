/**
 * Regression test for #1855: Stalled tool detection crashes with
 * "The path argument must be of type string. Received undefined"
 *
 * When a tool stalls in-flight for 10+ minutes, the idle watchdog fires
 * recoverTimedOutUnit(). In auto/phases.ts, buildRecoveryContext was
 * returning an empty object `{}`, so basePath was undefined. The recovery
 * code passed undefined to readUnitRuntimeRecord → runtimePath → join(),
 * which throws a TypeError. The session is permanently frozen because the
 * error propagates into the idle watchdog catch handler but the unit
 * promise is never resolved.
 *
 * This test calls recoverTimedOutUnit with an empty RecoveryContext (the
 * bug) and verifies it crashes, then calls it with a valid RecoveryContext
 * (the fix) and verifies it does not crash.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { recoverTimedOutUnit, type RecoveryContext } from "../auto-timeout-recovery.ts";
import { closeDatabase, getMilestoneSlices, getPlanMilestoneRecoveryBlock, insertAssessment, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { test } from 'node:test';
import assert from 'node:assert/strict';


// Minimal mock for ExtensionContext — only the fields recoverTimedOutUnit touches.
function makeMockCtx() {
  return {
    ui: {
      notify: () => {},
    },
  } as any;
}

// Minimal mock for ExtensionAPI — only sendMessage is called during recovery.
function makeMockPi() {
  return {
    sendMessage: () => {},
  } as any;
}

function makeRecordingPi() {
  const messages: unknown[] = [];
  return {
    messages,
    sendMessage: (message: unknown) => { messages.push(message); },
  } as any;
}

function makeRecordingCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify: (message: string, level: string) => { notifications.push({ message, level }); },
    },
  } as any;
}

// ═══ #1855: empty RecoveryContext (basePath undefined) crashes ════════════════

{
  console.log("\n=== #1855: recoverTimedOutUnit crashes when basePath is undefined ===");
  const ctx = makeMockCtx();
  const pi = makeMockPi();

  // Simulate the bug: buildRecoveryContext returns {} (empty object).
  // basePath is undefined, which causes join(undefined, ".gsd") to throw.
  const emptyRctx = {} as RecoveryContext;

  let crashed = false;
  try {
    await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", emptyRctx);
  } catch (err: any) {
    crashed = true;
    assert.ok(
      err.message.includes("path") || err.message.includes("string") || err.code === "ERR_INVALID_ARG_TYPE",
      `should crash with path/type error, got: ${err.message}`,
    );
  }
  assert.ok(crashed, "should crash when basePath is undefined (reproduces #1855)");
}

// ═══ validate-milestone timeout recovery trusts DB authority ════════════════

{
  console.log("\n=== validate-milestone timeout recovery accepts DB validation without Markdown ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-timeout-db-validation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "complete" });
    insertAssessment({
      path: ".gsd/milestones/M001/M001-VALIDATION.md",
      milestoneId: "M001",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n",
    });

    const ctx = makeRecordingCtx();
    const pi = makeRecordingPi();
    const result = await recoverTimedOutUnit(ctx, pi, "validate-milestone", "M001", "idle", {
      basePath: base,
      verbose: false,
      currentUnitStartedAt: Date.now(),
      unitRecoveryCount: new Map(),
    });

    assert.equal(result, "recovered");
    assert.equal(pi.messages.length, 0, "durable validation must advance without steering another model turn");
    assert.ok(
      ctx.notifications.some((entry: { message: string }) => entry.message.includes("durable outcome verified")),
      "recovery should explain that the database-backed outcome was verified",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
}

// ═══ Legacy DB-complete execute-task cannot bypass Attempt authority ═════════

{
  console.log("\n=== execute-task timeout recovery ignores closed Task row without Attempt proof ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-timeout-db-complete-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });

  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete" });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
      "# S01\n\n## Tasks\n\n- [ ] **T01: Task** `est:10m`\n",
      "utf-8",
    );
    writeFileSync(join(base, ".gsd", "STATE.md"), "## Next Action\nExecute T01 for S01: Task\n", "utf-8");

    const ctx = makeMockCtx();
    const pi = makeRecordingPi();
    const recoveryContext = {
      basePath: base,
      verbose: false,
      currentUnitStartedAt: Date.now(),
      unitRecoveryCount: new Map(),
    };
    const result = await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", recoveryContext);

    assert.equal(result, "recovered", "timeout recovery should steer the active canonical execution");
    assert.equal(pi.messages.length, 1, "a legacy closed Task row must not bypass canonical recovery");
    const runtime = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "units", "execute-task-M001-S01-T01.json"), "utf-8"));
    assert.equal(runtime.phase, "recovered", "projection-era Task completion is not canonical execution proof");
    assert.equal(runtime.recovery.dbComplete, true, "runtime recovery should record DB completion");

    await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", recoveryContext);
    await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", recoveryContext);
    const exhaustedRuntime = JSON.parse(readFileSync(
      join(base, ".gsd", "runtime", "units", "execute-task-M001-S01-T01.json"),
      "utf-8",
    ));
    assert.equal(exhaustedRuntime.phase, "recovered", "exhaustion must hand off to durable recovery, not mark the Task skipped");
    assert.equal(pi.messages.length, 2, "only bounded steering retries should emit new turns");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
}

// ═══ plan-slice timeout recovery verifies stale PLAN before advancing ═══════

{
  console.log("\n=== plan-slice timeout recovery rejects stale placeholder PLAN ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-timeout-stale-plan-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });

  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
    writeFileSync(
      join(sliceDir, "S01-PLAN.md"),
      "# S01: Slice\n\n## Tasks\n\nPlanning was interrupted before task rows were persisted.\n",
      "utf-8",
    );

    const ctx = makeRecordingCtx();
    const pi = makeRecordingPi();
    const result = await recoverTimedOutUnit(ctx, pi, "plan-slice", "M001/S01", "idle", {
      basePath: base,
      verbose: false,
      currentUnitStartedAt: Date.now(),
      unitRecoveryCount: new Map(),
    });

    assert.equal(result, "recovered", "invalid existing plan should enter steering recovery");
    assert.equal(pi.messages.length, 1, "invalid existing plan should trigger steering instead of advancing");
    assert.ok(
      ctx.notifications.some((entry: { message: string }) => entry.message.includes("steering plan-slice M001/S01")),
      "recovery notification should describe steering, not artifact advance",
    );
    assert.ok(
      !ctx.notifications.some((entry: { message: string }) => entry.message.includes("artifact already exists on disk. Advancing.")),
      "stale placeholder plan should not use the advance-on-existence path",
    );
    const runtime = JSON.parse(readFileSync(join(base, ".gsd", "runtime", "units", "plan-slice-M001-S01.json"), "utf-8"));
    assert.equal(runtime.phase, "recovered", "stale placeholder plan must not be finalized");
    assert.equal(runtime.recoveryAttempts, 1, "steering recovery attempt should be recorded");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
}

// ═══ plan-milestone timeout recovery fails closed without fake work ═══

test("plan-milestone timeout recovery persists a blocker and pauses", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-timeout-plan-milestone-blocked-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  const ctx = makeRecordingCtx();
  const pi = makeRecordingPi();
  const recoveryContext: RecoveryContext = {
    basePath: base,
    verbose: false,
    currentUnitStartedAt: Date.now(),
    unitRecoveryCount: new Map(),
  };

  assert.equal(await recoverTimedOutUnit(ctx, pi, "plan-milestone", "M001", "idle", recoveryContext), "recovered");
  assert.equal(await recoverTimedOutUnit(ctx, pi, "plan-milestone", "M001", "idle", recoveryContext), "recovered");
  assert.equal(await recoverTimedOutUnit(ctx, pi, "plan-milestone", "M001", "idle", recoveryContext), "paused");

  assert.deepEqual(getMilestoneSlices("M001"), [], "timeout recovery must not fabricate a completed slice");
  assert.match(getPlanMilestoneRecoveryBlock("M001")?.reason ?? "", /recovery exhausted/);
  assert.ok(
    ctx.notifications.some((entry: { message: string }) => entry.message.includes("no milestone work was marked complete")),
    "timeout recovery should explain why planning paused",
  );
});

// ═══ plan-slice verification accepts completed task summaries ═══════════════

{
  console.log("\n=== plan-slice verification accepts completed task summaries ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-slice-complete-summary-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S05");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S05", milestoneId: "M001", title: "Slice", status: "in_progress" });
    insertTask({ id: "T01", milestoneId: "M001", sliceId: "S05", title: "Done 1", status: "complete" });
    insertTask({ id: "T02", milestoneId: "M001", sliceId: "S05", title: "Done 2", status: "complete" });
    insertTask({ id: "T03", milestoneId: "M001", sliceId: "S05", title: "Pending 1", status: "pending" });
    insertTask({ id: "T04", milestoneId: "M001", sliceId: "S05", title: "Pending 2", status: "pending" });
    writeFileSync(
      join(sliceDir, "S05-PLAN.md"),
      [
        "# S05: Slice",
        "",
        "## Tasks",
        "",
        "- [x] **T01: Done 1** `est:10m`",
        "- [x] **T02: Done 2** `est:10m`",
        "- [ ] **T03: Pending 1** `est:10m`",
        "- [ ] **T04: Pending 2** `est:10m`",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n", "utf-8");
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "# T02 Summary\n", "utf-8");
    writeFileSync(join(tasksDir, "T03-PLAN.md"), "# T03 Plan\n", "utf-8");
    writeFileSync(join(tasksDir, "T04-PLAN.md"), "# T04 Plan\n", "utf-8");

    assert.equal(
      verifyExpectedArtifact("plan-slice", "M001/S05", base),
      true,
      "completed DB tasks should be accounted for by SUMMARY files",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
}

// ═══ #1855: valid RecoveryContext does not crash ═════════════════════════════

{
  console.log("\n=== #1855: recoverTimedOutUnit succeeds with valid RecoveryContext ===");
  const base = mkdtempSync(join(tmpdir(), "gsd-stalled-tool-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  mkdirSync(join(base, ".gsd", "runtime", "units"), { recursive: true });

  try {
    const ctx = makeMockCtx();
    const pi = makeMockPi();

    const validRctx: RecoveryContext = {
      basePath: base,
      verbose: false,
      currentUnitStartedAt: Date.now(),
      unitRecoveryCount: new Map(),
    };

    let crashed = false;
    let result: string | undefined;
    try {
      result = await recoverTimedOutUnit(ctx, pi, "execute-task", "M001/S01/T01", "idle", validRctx);
    } catch (err: any) {
      crashed = true;
      console.error(`  Unexpected crash: ${err.message}`);
    }
    assert.ok(!crashed, "should not crash with valid basePath");
    // With no runtime record on disk and recoveryAttempts=0, the function
    // should attempt steering recovery (sendMessage) and return "recovered".
    assert.ok(result === "recovered", `should return 'recovered', got '${result}'`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
