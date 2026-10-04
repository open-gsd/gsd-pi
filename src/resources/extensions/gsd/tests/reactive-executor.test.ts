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
import { handlePlanSlice } from "../tools/plan-slice.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import {
  _getPlannedKeyFilesForTest,
  _parseReactiveBatchTaskIdsForTest,
} from "../auto-post-unit.ts";

/**
 * Open a DB under `repo` and seed M001/S01 with the given task rows.
 * `loadSliceTaskIO` reads the task list (ids, titles, done) and the IO
 * signatures (inputs, expected output) from these rows. No PLAN file is
 * written: the fixtures prove that the graph needs none.
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
    // Task rows with non-overlapping IO (all independent). A reference can
    // carry a description after the path.
    seedSliceTasks(repo, [
      { id: "T01", title: "First", inputs: ["src/config.json — Config schema"], outputs: ["src/types.ts — Type definitions"] },
      { id: "T02", title: "Second", inputs: ["src/schema.json — Schema file"], outputs: ["src/models.ts — Model definitions"] },
      { id: "T03", title: "Third", inputs: ["src/api.json — API spec"], outputs: ["src/service.ts — Service layer"] },
    ]);

    // Load IO and build graph
    const taskIO = loadSliceTaskIO("M001", "S01");
    assert.deepEqual(
      taskIO.map((task) => [task.id, task.inputFiles, task.outputFiles]),
      [
        ["T01", ["src/config.json"], ["src/types.ts"]],
        ["T02", ["src/schema.json"], ["src/models.ts"]],
        ["T03", ["src/api.json"], ["src/service.ts"]],
      ],
    );

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

test("reactive dispatch falls through when the slice has a recorded reactive recovery block", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-blocker-dispatch-"));
  try {
    const sliceDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    seedSliceTasks(repo, ["T01", "T02", "T03"].map((tid) => ({
      id: tid,
      title: tid,
      inputs: [`src/${tid}.input`],
      outputs: [`src/${tid}.output`],
    })));
    writeFileSync(
      join(sliceDir, "S01-PLAN.md"),
      [
        "# S01: Test Slice",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First**",
        "- [ ] **T02: Second**",
        "- [ ] **T03: Third**",
        "",
      ].join("\n"),
    );
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
    writeFileSync(join(sliceDir, "S01-REACTIVE-BLOCKER.md"), "# BLOCKER\n");
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

const flatPhaseDispatch = (repo: string, prefs: unknown) => resolveDispatch({
  basePath: repo,
  mid: "M001",
  midTitle: "Milestone",
  state: {
    phase: "executing",
    activeMilestone: { id: "M001", title: "Milestone", status: "active" },
    activeSlice: { id: "S01", title: "Test Slice" },
    activeTask: { id: "T01", title: "T01" },
    registry: [],
    blockers: [],
  } as any,
  prefs: prefs as any,
});

function makeFlatPhaseRepo(t: { after: (fn: () => void) => void }): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-flat-phase-"));
  t.after(() => {
    closeDatabase();
    rmSync(repo, { recursive: true, force: true });
  });
  return repo;
}

test("a flat-phase slice gets its reactive graph from the task rows, with no task PLAN file", async (t) => {
  const repo = makeFlatPhaseRepo(t);
  seedSliceTasks(repo, ["T01", "T02", "T03"].map((tid) => ({
    id: tid,
    title: tid,
    inputs: [`src/${tid}.input`],
    outputs: [`src/${tid}.output`],
  })));
  const { renderPlanFromDb } = await import("../markdown-renderer.ts");
  const { planPath } = await renderPlanFromDb(repo, "M001", "S01");
  assert.ok(planPath.includes(join(".gsd", "phases")), `fixture must use the flat-phase layout, got ${planPath}`);
  // A PLAN projection that names other files changes nothing: the rows decide.
  writeFileSync(planPath, "# S01\n\n## Tasks\n\n- [ ] **T01: T01**\n  - Files: `src/shared.ts`\n");

  assert.deepEqual(
    loadSliceTaskIO("M001", "S01").map((task) => [task.id, task.inputFiles, task.outputFiles]),
    ["T01", "T02", "T03"].map((tid) => [tid, [`src/${tid}.input`], [`src/${tid}.output`]]),
  );

  const action = await flatPhaseDispatch(repo, { reactive_execution: { enabled: true, max_parallel: 3 } });
  assert.equal(action.action === "dispatch" ? action.unitType : action.action, "reactive-execute");
  assert.equal(action.action === "dispatch" ? action.unitId : null, "M001/S01/reactive+T01,T02,T03");
});

test("a slice whose planned tasks have a lifecycle row keeps sequential dispatch", async (t) => {
  // gsd_plan_slice gives each Task a lifecycle row. Only the running Attempt
  // of the host completes such a Task, and a batch subagent holds no Attempt.
  const repo = makeFlatPhaseRepo(t);
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  openDatabase(join(repo, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Test Slice", status: "pending", risk: "low", depends: [] });
  for (const tid of ["T01", "T02", "T03"]) writeFileSync(join(repo, "src", `${tid}.input`), "fixture\n");
  const planned = await handlePlanSlice({
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Three independent tasks.",
    successCriteria: "- Each task writes its own file",
    proofLevel: "integration",
    integrationClosure: "None.",
    observabilityImpact: "None.",
    tasks: ["T01", "T02", "T03"].map((tid) => ({
      taskId: tid,
      title: tid,
      description: `Write src/${tid}.output.`,
      estimate: "15m",
      files: [`src/${tid}.output`],
      verify: "node --test",
      inputs: [`src/${tid}.input`],
      expectedOutput: [`src/${tid}.output`],
      requiredWorkflowTools: [],
    })),
  }, repo, internalPlanningInvocation());
  assert.ok(!("error" in planned), `plan-slice failed: ${"error" in planned ? planned.error : ""}`);
  assert.equal(
    getReadyTasks(deriveTaskGraph(loadSliceTaskIO("M001", "S01")), new Set(), new Set()).length,
    3,
    "the task rows hold three independent ready tasks",
  );

  for (const prefs of [undefined, { reactive_execution: { enabled: true, max_parallel: 3 } }]) {
    const action = await flatPhaseDispatch(repo, prefs);
    assert.equal(action.action === "dispatch" ? action.unitType : action.action, "execute-task");
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

    const taskIO = loadSliceTaskIO("M001", "S01");
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

    const taskIO = loadSliceTaskIO("M001", "S01");
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

    const taskIO = loadSliceTaskIO("M001", "S01");
    assert.deepEqual(taskIO.map((task) => task.done), [true, false, false]);
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
