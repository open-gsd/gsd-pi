import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSliceTaskIO,
  deriveTaskGraph,
  isGraphAmbiguous,
  getReadyTasks,
  chooseNonConflictingSubset,
} from "../reactive-graph.ts";
import { validatePreferences } from "../preferences-validation.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";
import { parseUnitId } from "../unit-id.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import {
  _getPlannedKeyFilesForTest,
  _parseReactiveBatchTaskIdsForTest,
} from "../auto-post-unit.ts";

/**
 * Open a DB under `repo` and seed M001/S01 with the given task rows.
 * `loadSliceTaskIO` reads everything from the task rows (ADR-046): ids, titles,
 * done status, and the planned inputs and expected output. No PLAN file is
 * written by these fixtures.
 */
function seedSliceTasks(
  repo: string,
  tasks: Array<{ id: string; title: string; status?: string; inputs?: string[]; outputs?: string[] }>,
): void {
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  openDatabase(join(repo, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Test Slice", status: "in_progress", risk: "low", depends: [] });
  tasks.forEach((task, index) => {
    insertTask({
      milestoneId: "M001",
      sliceId: "S01",
      id: task.id,
      title: task.title,
      status: task.status ?? "pending",
      sequence: index,
      planning: { inputs: task.inputs ?? [], expectedOutput: task.outputs ?? [] },
    });
  });
}

// ─── Preference Validation ────────────────────────────────────────────────

test("reactive_execution validation accepts valid config", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 4,
      isolation_mode: "same-tree",
    },
  });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.preferences.reactive_execution, {
    enabled: true,
    max_parallel: 4,
    isolation_mode: "same-tree",
  });
});

test("reactive_execution validation rejects max_parallel out of range", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 10,
      isolation_mode: "same-tree",
    } as any,
  });
  assert.ok(result.errors.some((e) => e.includes("max_parallel")));
});

test("reactive_execution validation rejects invalid isolation_mode", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "separate-branch",
    } as any,
  });
  assert.ok(result.errors.some((e) => e.includes("isolation_mode")));
});

test("reactive_execution validation warns on unknown keys", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      unknown_thing: true,
    } as any,
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("unknown_thing")));
});

test("reactive batch unit ids are parsed and deduped for commit context", () => {
  assert.deepEqual(
    _parseReactiveBatchTaskIdsForTest("M001/S01/reactive+T01,t02,T01"),
    ["T01", "T02"],
  );
  assert.deepEqual(_parseReactiveBatchTaskIdsForTest("M001/S01/T01"), []);
});

test("reactive commit context key files include planned output, files, and key_files once", () => {
  const result = _getPlannedKeyFilesForTest([
    {
      expected_output: ["src/new.ts", "src/shared.ts"],
      files: ["src/input.ts", "src/shared.ts"],
      key_files: ["src/key.ts"],
    },
    {
      expected_output: ["src/new.ts"],
      files: ["src/other.ts"],
      key_files: ["src/key.ts", "src/final.ts"],
    },
  ]);

  assert.deepEqual(result, [
    "src/new.ts",
    "src/shared.ts",
    "src/input.ts",
    "src/key.ts",
    "src/other.ts",
    "src/final.ts",
  ]);
});

// ─── Dispatch Rule Matching Logic ─────────────────────────────────────────

test("reactive dispatch requires enabled config and multiple ready tasks", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-dispatch-"));
  try {
    // Three tasks with non-overlapping IO (all independent)
    seedSliceTasks(repo, [
      { id: "T01", title: "First", inputs: ["src/config.json"], outputs: ["src/types.ts"] },
      { id: "T02", title: "Second", inputs: ["src/schema.json"], outputs: ["src/models.ts"] },
      { id: "T03", title: "Third", inputs: ["src/api.json"], outputs: ["src/service.ts"] },
    ]);

    // Load IO and build graph
    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    assert.equal(taskIO.length, 3);
    assert.deepEqual(taskIO[0], {
      id: "T01",
      title: "First",
      inputFiles: ["src/config.json"],
      outputFiles: ["src/types.ts"],
      done: false,
    });

    const graph = deriveTaskGraph(taskIO);
    assert.equal(isGraphAmbiguous(graph), false, "Graph should not be ambiguous");

    // All independent → all should be ready
    const ready = getReadyTasks(graph, new Set(), new Set());
    assert.equal(ready.length, 3);

    // Choose subset with max_parallel=2
    const selected = chooseNonConflictingSubset(ready, graph, 2, new Set());
    assert.equal(selected.length, 2);
    assert.deepEqual(selected, ["T01", "T02"]);
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("task IO comes from the task rows, not from task PLAN files", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-io-rows-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    seedSliceTasks(repo, [
      { id: "T01", title: "First", inputs: ["src/config.json"], outputs: ["src/a.ts"] },
      { id: "T02", title: "Second", inputs: ["src/a.ts"], outputs: ["src/b.ts"] },
    ]);
    // A PLAN file that contradicts the rows: it makes T02 independent of T01.
    writeFileSync(
      join(tasksDir, "T02-PLAN.md"),
      "# T02: Second\n\n## Inputs\n\n- `src/other.json`\n\n## Expected Output\n\n- `src/z.ts`\n",
    );

    const graph = deriveTaskGraph(await loadSliceTaskIO(repo, "M001", "S01"));

    assert.deepEqual(getReadyTasks(graph, new Set(), new Set()), ["T01"], "T02 depends on T01 per the rows");
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reactive dispatch falls through when the slice has a recorded reactive recovery block", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-blocker-dispatch-"));
  try {
    mkdirSync(join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    seedSliceTasks(repo, ["T01", "T02", "T03"].map((tid) => ({
      id: tid,
      title: tid,
      inputs: [`src/${tid}.input`],
      outputs: [`src/${tid}.output`],
    })));
    const dispatch = () => resolveDispatch({
      basePath: repo,
      mid: "M001",
      midTitle: "Milestone",
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone", status: "active" },
        activeSlice: { id: "S01", title: "Test Slice" },
        activeTask: { id: "T01", title: "First" },
        registry: [],
        blockers: [],
      } as any,
      prefs: { reactive_execution: { enabled: true, max_parallel: 3 } } as any,
    });

    const before = await dispatch();
    assert.equal(
      before.action === "dispatch" ? before.unitType : null,
      "reactive-execute",
      "three independent ready tasks dispatch as a reactive batch",
    );

    // A REACTIVE-BLOCKER file with no recorded row decides nothing.
    writeFileSync(join(repo, ".gsd", "milestones", "M001", "slices", "S01", "S01-REACTIVE-BLOCKER.md"), "# BLOCKER\n");
    const withFileOnly = await dispatch();
    assert.equal(withFileOnly.action === "dispatch" ? withFileOnly.unitType : null, "reactive-execute");

    const { writeReactiveExecuteBlocker } = await import("../auto-recovery.ts");
    assert.ok(writeReactiveExecuteBlocker("M001/S01/reactive+T01,T02,T03", repo, "verification retries exhausted"));
    const after = await dispatch();
    assert.notEqual(
      after.action === "dispatch" ? after.unitType : null,
      "reactive-execute",
      "the recorded recovery block should prevent another reactive batch dispatch",
    );
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reactive dispatch falls back when graph is ambiguous (task without IO)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-ambiguous-"));
  try {
    // T01 has IO, T02 has none → ambiguous
    seedSliceTasks(repo, [
      { id: "T01", title: "A", inputs: ["src/a.ts"], outputs: ["src/b.ts"] },
      { id: "T02", title: "B" },
    ]);

    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    assert.equal(isGraphAmbiguous(graph), true, "Graph should be ambiguous");
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("single ready task falls through to sequential", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-single-"));
  try {
    seedSliceTasks(repo, [
      { id: "T01", title: "First", inputs: ["src/config.json"], outputs: ["src/a.ts"] },
      { id: "T02", title: "Second", inputs: ["src/a.ts"], outputs: ["src/b.ts"] },
    ]);

    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    const ready = getReadyTasks(graph, new Set(), new Set());
    // Only T01 is ready (T02 depends on T01)
    assert.equal(ready.length, 1);
    assert.deepEqual(ready, ["T01"]);
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Re-entry ─────────────────────────────────────────────────────────────

test("completed tasks are not re-dispatched on next iteration", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-reentry-"));
  try {
    seedSliceTasks(repo, [
      { id: "T01", title: "Done", status: "complete", inputs: ["src/config.json"], outputs: ["src/a.ts"] },
      { id: "T02", title: "Pending", inputs: ["src/a.ts"], outputs: ["src/b.ts"] },
      { id: "T03", title: "Also Pending", inputs: ["src/a.ts"], outputs: ["src/c.ts"] },
    ]);

    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);

    // T01 is done, T02 and T03 depend on T01
    const completed = new Set(["T01"]);
    const ready = getReadyTasks(graph, completed, new Set());
    // Both T02 and T03 should be ready (T01 is complete)
    assert.deepEqual(ready, ["T02", "T03"]);

    // Simulate T02 completes, re-derive
    completed.add("T02");
    const ready2 = getReadyTasks(graph, completed, new Set());
    // Only T03 should be ready
    assert.deepEqual(ready2, ["T03"]);
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Batch Verification ───────────────────────────────────────────────────

test("verifyExpectedArtifact: reactive-execute passes when every dispatched task is closed in the DB", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-pass-"));
  try {
    seedSliceTasks(repo, [
      { id: "T02", title: "Second", status: "complete" },
      { id: "T03", title: "Third", status: "complete" },
    ]);

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, true, "Should pass when all dispatched tasks are closed, with no SUMMARY file");
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyExpectedArtifact: reactive-execute fails when a dispatched task is still open", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-fail-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    seedSliceTasks(repo, [
      { id: "T02", title: "Second", status: "complete" },
      { id: "T03", title: "Third" },
    ]);
    // A SUMMARY file for the open task does not close it.
    writeFileSync(join(tasksDir, "T03-SUMMARY.md"), "---\nid: T03\n---\n# T03: Done\n");

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, false, "Should fail when dispatched task T03 is open in the DB");
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyExpectedArtifact: reactive-execute fails even when other tasks of the slice are closed", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-preexisting-"));
  try {
    // T01 was closed before; T02 and T03 were dispatched and are still open
    seedSliceTasks(repo, [
      { id: "T01", title: "Prior", status: "complete" },
      { id: "T02", title: "Second" },
      { id: "T03", title: "Third" },
    ]);

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, false, "A closed T01 should not satisfy the T02,T03 batch");
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyExpectedArtifact: reactive-execute with no batch IDs fails closed", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-legacy-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    seedSliceTasks(repo, [{ id: "T01", title: "First", status: "complete" }]);
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");

    // A unit id without the +batch suffix names no task to check.
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive", repo);
    assert.equal(result, false, "A batch with no task ids cannot be verified from any SUMMARY file");
  } finally {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unitId batch encoding round-trips correctly", () => {
  const mid = "M001";
  const sid = "S01";
  const selected = ["T02", "T03", "T05"];
  const unitId = `${mid}/${sid}/reactive+${selected.join(",")}`;

  // Parse it back
  const { milestone, slice, task: batchPart } = parseUnitId(unitId);
  assert.equal(milestone, "M001");
  assert.equal(slice, "S01");
  const plusIdx = batchPart!.indexOf("+");
  assert.ok(plusIdx > 0, "Should have + separator");
  const batchIds = batchPart!.slice(plusIdx + 1).split(",");
  assert.deepEqual(batchIds, ["T02", "T03", "T05"]);
});

// ─── Dependency-Based Carry-Forward ───────────────────────────────────────

test("getDependencyTaskSummaryPaths returns only dependency summaries", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // T01, T02, T03 all have summaries
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02\n");
    writeFileSync(join(tasksDir, "T03-SUMMARY.md"), "---\nid: T03\n---\n# T03\n");

    // T04 depends only on T01 and T03 — should NOT get T02
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T04", ["T01", "T03"], repo);
    assert.equal(paths.length, 2, "Should get exactly 2 dependency summaries");
    assert.ok(paths.some((p) => p.includes("T01-SUMMARY")), "Should include T01");
    assert.ok(paths.some((p) => p.includes("T03-SUMMARY")), "Should include T03");
    assert.ok(!paths.some((p) => p.includes("T02-SUMMARY")), "Should NOT include T02");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getDependencyTaskSummaryPaths falls back to order-based for root tasks", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-root-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");

    // T02 has no dependencies (root task) — should fall back to order-based
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T02", [], repo);
    assert.equal(paths.length, 1, "Root task should get order-based prior summaries");
    assert.ok(paths[0].includes("T01-SUMMARY"), "Should include T01 via order fallback");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getDependencyTaskSummaryPaths handles missing dependency summaries gracefully", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-missing-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Only T01 has a summary, T02 does not
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");

    // T03 depends on T01 and T02, but T02 summary doesn't exist
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T03", ["T01", "T02"], repo);
    assert.equal(paths.length, 1, "Should only return existing dependency summaries");
    assert.ok(paths[0].includes("T01-SUMMARY"), "Should include T01 (exists)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("#1343: getPriorTaskSummaryPaths excludes sibling-slice summaries in flat-phase", async () => {
  const { getPriorTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-flat-prior-"));
  try {
    // Flat-phase: slices S01 and S02 share the phase dir and overlap task ids.
    const phaseDir = join(repo, ".gsd", "phases", "01-test");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "S01-T01-SUMMARY.md"), "---\nid: T01\n---\n# S01 T01\n");
    writeFileSync(join(phaseDir, "S02-T01-SUMMARY.md"), "---\nid: T01\n---\n# S02 T01\n");

    // S02/T02 prior summaries must not pull the sibling S01-T01 summary.
    const paths = await getPriorTaskSummaryPaths("M001", "S02", "T02", repo);
    assert.equal(paths.length, 1, "Should only return the current slice's prior summary");
    assert.ok(paths[0].includes("S02-T01-SUMMARY"), "Should include S02's T01");
    assert.ok(!paths.some((p) => p.includes("S01-T01-SUMMARY")), "Should NOT include sibling S01's T01");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("#1343: getDependencyTaskSummaryPaths excludes sibling-slice summaries in flat-phase", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-flat-dep-"));
  try {
    const phaseDir = join(repo, ".gsd", "phases", "01-test");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "S01-T01-SUMMARY.md"), "---\nid: T01\n---\n# S01 T01\n");
    writeFileSync(join(phaseDir, "S02-T01-SUMMARY.md"), "---\nid: T01\n---\n# S02 T01\n");

    // S02/T02 depends on T01 — must resolve S02's T01, not the sibling S01's.
    const paths = await getDependencyTaskSummaryPaths("M001", "S02", "T02", ["T01"], repo);
    assert.equal(paths.length, 1, "Should only return the current slice's dependency summary");
    assert.ok(paths[0].includes("S02-T01-SUMMARY"), "Should include S02's T01");
    assert.ok(!paths.some((p) => p.includes("S01-T01-SUMMARY")), "Should NOT include sibling S01's T01");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
