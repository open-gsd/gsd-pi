import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  verifyExpectedArtifact,
  buildLoopRemediationSteps,
} from "../../auto-recovery.ts";
import {
  closeDatabase,
  getMilestoneSlices,
  getPlanMilestoneRecoveryBlock,
  getSlice,
  getSliceTasks,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../../state.ts";
import { recoverTimedOutUnit } from "../../auto-timeout-recovery.ts";
import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "../../unit-runtime.ts";
import { drainLogs, setStderrLoggingEnabled, _resetLogs } from "../../workflow-logger.ts";
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-idle-recovery-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

/** Open a DB under `base` and seed M001/S01 with the given slice status. */
function seedSlice(base: string, status: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Test Slice", status, risk: "low", depends: [] });
}

function cleanup(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

// ═══ resolveExpectedArtifactPath ═════════════════════════════════════════════

test('resolveExpectedArtifactPath: research-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-milestone", "M001", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("M001-RESEARCH.md"), `path should end with M001-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: plan-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("M001-ROADMAP.md"), `path should end with M001-ROADMAP.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: research-slice', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("S01-RESEARCH.md"), `path should end with S01-RESEARCH.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: plan-slice', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("S01-PLAN.md"), `path should end with S01-PLAN.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: complete-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert.ok(result !== null, "should resolve a path");
    assert.ok(result!.endsWith("M001-SUMMARY.md"), `path should end with M001-SUMMARY.md, got ${result}`);
  } finally {
    cleanup(base);
  }
});

test('resolveExpectedArtifactPath: unknown unit type → null', () => {
  const base = createFixtureBase();
  try {
    const result = resolveExpectedArtifactPath("unknown-type", "M001/S01", base);
    assert.deepStrictEqual(result, null, "unknown type returns null");
  } finally {
    cleanup(base);
  }
});

// ═══ writeBlockerPlaceholder ═════════════════════════════════════════════════

test('writeBlockerPlaceholder: writes file for research-slice', () => {
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("research-slice", "M001/S01", base, "idle recovery exhausted 2 attempts");
    assert.ok(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-slice", "M001/S01", base)!;
    assert.ok(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assert.ok(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assert.ok(content.includes("idle recovery exhausted 2 attempts"), "should contain the reason");
    assert.ok(content.includes("research-slice"), "should mention the unit type");
    assert.ok(content.includes("M001/S01"), "should mention the unit ID");
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: creates directory if missing', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-idle-recovery-test-"));
  try {
    // Only create milestone dir, not slice dir
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    // resolveSliceArtifactPath now returns a canonical path even when the dir
    // doesn't exist (relSliceFile fallback), so writeBlockerPlaceholder creates
    // the directory and writes the placeholder file — returning a non-null diagnosis.
    const result = writeBlockerPlaceholder("research-slice", "M001/S01", base, "test reason");
    assert.ok(result !== null, "should return a diagnosis string when the dir is missing (creates it)");
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: writes file for research-milestone', () => {
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("research-milestone", "M001", base, "hard timeout");
    assert.ok(result !== null, "should return relative path");
    const absPath = resolveExpectedArtifactPath("research-milestone", "M001", base)!;
    assert.ok(existsSync(absPath), "file should exist on disk");
    const content = readFileSync(absPath, "utf-8");
    assert.ok(content.includes("BLOCKER"), "should contain BLOCKER heading");
    assert.ok(content.includes("hard timeout"), "should contain the reason");
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: plan-slice diagnostics preserve the canonical PLAN', (t) => {
  const base = createFixtureBase();
  t.after(() => cleanup(base));
  const planPath = resolveExpectedArtifactPath("plan-slice", "M001/S01", base)!;
  const blockerPath = planPath.replace(/-PLAN\.md$/u, "-RECOVERY-BLOCKER.md");
  const partialPlan = "# S01: Partial plan\n\nPlanning was interrupted before tasks were persisted.\n";
  writeFileSync(planPath, partialPlan, "utf-8");

  const result = writeBlockerPlaceholder(
    "plan-slice",
    "M001/S01",
    base,
    "idle recovery exhausted 2 attempts",
  );

  assert.equal(result, join(".gsd", "milestones", "M001", "slices", "S01", "S01-RECOVERY-BLOCKER.md"));
  assert.equal(readFileSync(planPath, "utf-8"), partialPlan, "the canonical PLAN must remain untouched");
  assert.equal(existsSync(blockerPath), true, "the recovery diagnostic should use a sidecar");
  assert.match(readFileSync(blockerPath, "utf-8"), /idle recovery exhausted 2 attempts/u);
});

test('exhausted plan-slice timeout recovery pauses without fabricating completion', async (t) => {
  const base = createFixtureBase();
  t.after(() => cleanup(base));
  const planPath = resolveExpectedArtifactPath("plan-slice", "M001/S01", base)!;
  const blockerPath = planPath.replace(/-PLAN\.md$/u, "-RECOVERY-BLOCKER.md");
  const partialPlan = "# S01: Partial plan\n\nPlanning was interrupted before tasks were persisted.\n";
  const startedAt = Date.now();
  const notifications: string[] = [];
  const messages: unknown[] = [];
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Test Slice", status: "pending" });
  writeFileSync(planPath, partialPlan, "utf-8");
  writeUnitRuntimeRecord(base, "plan-slice", "M001/S01", startedAt, { recoveryAttempts: 2 });

  const result = await recoverTimedOutUnit(
    { ui: { notify: (message: string) => notifications.push(message) } } as any,
    { sendMessage: (message: unknown) => messages.push(message) } as any,
    "plan-slice",
    "M001/S01",
    "idle",
    {
      basePath: base,
      verbose: false,
      currentUnitStartedAt: startedAt,
      unitRecoveryCount: new Map(),
    },
  );

  assert.equal(result, "paused", "exhausted planning recovery must stop fail-closed");
  assert.equal(readUnitRuntimeRecord(base, "plan-slice", "M001/S01")?.phase, "paused");
  assert.equal(readFileSync(planPath, "utf-8"), partialPlan, "the partial canonical PLAN must be preserved");
  assert.equal(existsSync(blockerPath), false, "timeout pause does not need to fabricate an artifact");
  assert.equal(getSlice("M001", "S01")?.status, "pending", "recovery must leave the slice pending");
  assert.equal(getSliceTasks("M001", "S01").length, 0, "recovery must not fabricate task rows");
  assert.equal(messages.length, 0, "exhaustion must not schedule another model turn");
  assert.equal(notifications.filter((message) => message.includes("recovery exhausted")).length, 1);
  assert.equal(notifications.some((message) => message.includes("Advancing pipeline")), false);
});

test('writeBlockerPlaceholder: unknown type → null', () => {
  const base = createFixtureBase();
  try {
    const result = writeBlockerPlaceholder("unknown-type", "M001/S01", base, "test");
    assert.deepStrictEqual(result, null, "unknown type returns null");
  } finally {
    cleanup(base);
  }
});

// ═══ verifyExpectedArtifact: complete-slice completion check ═════════════════
// Regression for #indefinite-hang: complete-slice must verify the slice is
// actually complete or the idempotency skip loops forever after a crash that
// wrote SUMMARY+UAT but never closed the slice. Completion is DB-authoritative
// (ADR-017), so the check reads the slice row; the ROADMAP text below is a
// projection kept in the fixtures to prove it is NOT what decides the outcome.

const ROADMAP_INCOMPLETE = `# M001: Test Milestone

## Slices

- [ ] **S01: Test Slice** \`risk:low\`
> After this: something works
`;

const ROADMAP_COMPLETE = `# M001: Test Milestone

## Slices

- [x] **S01: Test Slice** \`risk:low\`
> After this: something works
`;

test('verifyExpectedArtifact: complete-slice — all artifacts present + roadmap marked [x] returns true', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_COMPLETE, "utf-8");
    seedSlice(base, "complete");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === true, "SUMMARY + UAT + roadmap [x] should verify as true");
  } finally {
    cleanup(base);
  }
});

test('verifyExpectedArtifact: complete-slice — SUMMARY + UAT present but the slice row is not complete returns false', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_INCOMPLETE, "utf-8");
    seedSlice(base, "in_progress");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === false, "an unfinished slice row should return false (crash recovery scenario)");
  } finally {
    cleanup(base);
  }
});

test('verifyExpectedArtifact: complete-slice — SUMMARY present but UAT missing returns false', () => {
  const base = createFixtureBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    // no UAT file
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), ROADMAP_COMPLETE, "utf-8");
    seedSlice(base, "complete");
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.ok(result === false, "missing UAT should return false");
  } finally {
    cleanup(base);
  }
});

test('verifyExpectedArtifact: complete-slice — unconfirmable completion fails closed (returns false)', () => {
  // This case used to be "lenient": with no roadmap and no DB, SUMMARY + UAT
  // alone verified as true — a silent verify-pass that let the loop advance a
  // slice nothing had confirmed complete. Completion is DB-authoritative
  // (ADR-017), so an unreadable slice row now fails closed and says why.
  const base = createFixtureBase();
  const previousStderr = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\n", "utf-8");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\n", "utf-8");
    // no roadmap file, and no DB to read the slice row from
    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    const logs = drainLogs();
    assert.ok(result === false, "unconfirmable slice completion must fail closed, not pass silently");
    const recovery = logs.find((e) => e.component === "recovery" && /verify-fail complete-slice M001\/S01/u.test(e.message));
    assert.ok(recovery, "a recovery warning must name why completion could not be confirmed");
    assert.match(recovery!.message, /DB unavailable/u);
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previousStderr);
    cleanup(base);
  }
});

// ═══ buildLoopRemediationSteps ═══════════════════════════════════════════════

test('buildLoopRemediationSteps: execute-task returns concrete steps', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S03", "tasks"), { recursive: true });
    const result = buildLoopRemediationSteps("execute-task", "M002/S03/T01", base);
    assert.ok(result !== null, "should return remediation steps");
    assert.ok(result!.includes("gsd undo-task"), "steps include undo-task command");
    assert.ok(result!.includes("T01"), "steps mention the task ID");
    assert.ok(result!.includes("gsd undo-task"), "steps include gsd undo-task command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildLoopRemediationSteps: plan-slice returns concrete steps', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const result = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
    assert.ok(result !== null, "should return remediation steps for plan-slice");
    assert.ok(result!.includes("S01-PLAN.md"), "steps mention the slice plan file");
    assert.ok(result!.includes("gsd recover"), "steps include gsd recover command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildLoopRemediationSteps: research-slice returns concrete steps', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    const result = buildLoopRemediationSteps("research-slice", "M001/S01", base);
    assert.ok(result !== null, "should return remediation steps for research-slice");
    assert.ok(result!.includes("S01-RESEARCH.md"), "steps mention the slice research file");
    assert.ok(result!.includes("gsd recover"), "steps include gsd recover command");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildLoopRemediationSteps: unknown type returns null', () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-loop-remediation-test-"));
  try {
    const result = buildLoopRemediationSteps("unknown-type", "M001/S01", base);
    assert.deepStrictEqual(result, null, "unknown type returns null");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══ verifyExpectedArtifact: hook unit types ═════════════════════════════════

test('verifyExpectedArtifact: hook types always return true', () => {
  const base = createFixtureBase();
  try {
    // Hook units don't have standard artifacts — they should always pass
    const result1 = verifyExpectedArtifact("hook/code-review", "M001/S01/T01", base);
    assert.ok(result1, "hook/code-review should always return true");

    const result2 = verifyExpectedArtifact("hook/simplify", "M001/S01/T02", base);
    assert.ok(result2, "hook/simplify should always return true");

    const result3 = verifyExpectedArtifact("hook/custom-hook", "M001/S01", base);
    assert.ok(result3, "hook/custom-hook at slice level should return true");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


test('writeBlockerPlaceholder: execute-task diagnostics never update DB authority', async () => {
  const base = createFixtureBase();
  try {
    const { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getTask, isDbAvailable } =
      await import("../../gsd-db.ts");

    const dbPath = join(base, ".gsd", "gsd.db");
    // Create the tasks directory (required for artifact path resolution)
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });

    openDatabase(dbPath);
    try {
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "idle recovery exhausted");

      const task = getTask("M001", "S01", "T01");
      assert.equal(task?.status, "pending",
        "a placeholder must not derive canonical Task completion");

      const verified = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
      assert.equal(verified, false,
        "a diagnostic placeholder must not satisfy Task completion verification");
    } finally {
      if (isDbAvailable()) closeDatabase();
    }
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: does NOT update DB for non-execute-task types', async () => {
  const base = createFixtureBase();
  try {
    const { openDatabase, closeDatabase, insertMilestone, insertSlice, getSlice, isDbAvailable } =
      await import("../../gsd-db.ts");

    const dbPath = join(base, ".gsd", "gsd.db");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    openDatabase(dbPath);
    try {
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });

      // research-slice is NOT execute-task — DB should NOT be updated
      writeBlockerPlaceholder("research-slice", "M001/S01", base, "idle recovery exhausted");

      const slice = getSlice("M001", "S01");
      assert.equal(slice?.status, "active",
        "writeBlockerPlaceholder should not change DB status for non-execute-task types");
    } finally {
      if (isDbAvailable()) closeDatabase();
    }
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder leaves execute-task plan projection and DB authority unchanged', async () => {
  const base = createFixtureBase();
  try {
    const {
      openDatabase,
      closeDatabase,
      insertMilestone,
      insertSlice,
      insertTask,
      getTask,
      isDbAvailable,
    } = await import("../../gsd-db.ts");

    const dbPath = join(base, ".gsd", "gsd.db");
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");

    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Recoverable task** `est:5m`",
    ].join("\n"));

    openDatabase(dbPath);
    try {
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Recoverable task", status: "pending" });

      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "context exhaustion recovery");

      const task = getTask("M001", "S01", "T01");
      assert.equal(task?.status, "pending", "execute-task recovery cannot fabricate Task completion");

      const planContent = readFileSync(join(sliceDir, "S01-PLAN.md"), "utf-8");
      assert.match(
        planContent,
        /\- \[ \] \*\*T01: Recoverable task\*\*/,
        "diagnostic recovery must not rewrite the plan projection as complete",
      );
    } finally {
      if (isDbAvailable()) closeDatabase();
    }
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: complete-slice diagnostics never fabricate Slice authority', async () => {
  const base = createFixtureBase();
  try {
    const { openDatabase, closeDatabase, insertMilestone, insertSlice, getSlice, isDbAvailable } =
      await import("../../gsd-db.ts");

    const dbPath = join(base, ".gsd", "gsd.db");
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

    openDatabase(dbPath);
    try {
      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });

      writeBlockerPlaceholder("complete-slice", "M001/S01", base, "context exhaustion recovery");

      const slice = getSlice("M001", "S01");
      assert.equal(
        slice?.status,
        "active",
        "diagnostic recovery must leave Slice authority unchanged",
      );
    } finally {
      if (isDbAvailable()) closeDatabase();
    }
  } finally {
    cleanup(base);
  }
});

test('writeBlockerPlaceholder: plan-milestone failure records a durable blocker without completed slices', async (t) => {
  const base = createFixtureBase();
  t.after(() => cleanup(base));
  const dbPath = join(base, ".gsd", "gsd.db");
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  writeBlockerPlaceholder("plan-milestone", "M001", base, "idle recovery exhausted");

  const slices = getMilestoneSlices("M001");
  assert.deepEqual(slices, [], "planning recovery must not fabricate completed milestone work");
  assert.match(
    getPlanMilestoneRecoveryBlock("M001")?.reason ?? "",
    /idle recovery exhausted/,
    "planning failure should be durably queryable",
  );

  invalidateStateCache();
  const state = await deriveState(base);
  assert.equal(state.phase, "blocked", "planning failure must stop dispatch before validation");
  assert.equal(state.activeMilestone?.id, "M001");
  assert.match(state.blockers.join("\n"), /idle recovery exhausted/);

  insertSlice({ id: "S01", milestoneId: "M001", title: "Real work", status: "pending" });
  invalidateStateCache();
  const recoveredState = await deriveState(base);
  assert.notEqual(
    recoveredState.phase,
    "blocked",
    "a successfully persisted real slice should supersede the recovery gate",
  );
});
