import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  getArtifact,
  getAssessment,
  getSlice,
  insertAssessment,
  insertGateRow,
  insertMilestone,
  setSliceSummaryMd,
  upsertRequirement,
  getAllMilestones,
} from "../gsd-db.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { getAutoWorker, registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease, getMilestoneLease } from "../db/milestone-leases.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { normalizeRealPath, relSliceFile, targetMilestoneFile } from "../paths.ts";
import { _setManagedProjectionWriteFaultForTest } from "../managed-projection-history.ts";
import { recordUnitHarnessAbort } from "../unit-runtime.ts";
import { markApprovalGateVerified, markDepthVerified, clearDiscussionFlowState, loadWriteGateSnapshot, setPendingGate } from "../bootstrap/write-gate.ts";
import {
  executeCompleteMilestone as executeCompleteMilestoneWithInvocation,
  executePlanMilestone as executePlanMilestoneWithInvocation,
  executePlanSlice as executePlanSliceWithInvocation,
  executeReplanSlice as executeReplanSliceWithInvocation,
  executeReassessRoadmap as executeReassessRoadmapWithInvocation,
  executeSaveGateResult,
  executeSummarySave,
  executeTaskComplete,
  executeMilestoneStatus,
  executeSliceComplete as executeSliceCompleteWithInvocation,
  executeSliceReopen as executeSliceReopenWithInvocation,
  executeSkipSlice as executeSkipSliceWithInvocation,
  executeValidateMilestone,
  executeUatResultSave,
} from "../tools/workflow-tool-executors.ts";
import { internalExecutionInvocation, type ExecutionInvocation } from "../execution-invocation.ts";
import { internalPlanningInvocation } from "../planning-invocation.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";
import {
  initNotificationStore,
  readNotifications,
  _resetNotificationStore,
} from "../notification-store.ts";
import {
  _setManagedProjectionApplyFaultForTest,
} from "../managed-projection-history.ts";
import { removeProjectionFileSync } from "../atomic-write.ts";
import { discardProjectionEvidence } from "./projection-evidence-helpers.ts";

function executePlanMilestone(
  params: Parameters<typeof executePlanMilestoneWithInvocation>[0],
  basePath: string,
) {
  return executePlanMilestoneWithInvocation(params, basePath, internalPlanningInvocation());
}

function executeCompleteMilestone(
  params: Parameters<typeof executeCompleteMilestoneWithInvocation>[0],
  basePath: string,
) {
  return executeCompleteMilestoneWithInvocation(
    params,
    basePath,
    internalExecutionInvocation("test:complete-milestone"),
  );
}

function executePlanSlice(
  params: Parameters<typeof executePlanSliceWithInvocation>[0],
  basePath: string,
) {
  return executePlanSliceWithInvocation(params, basePath, internalPlanningInvocation());
}

function executeReplanSlice(
  params: Parameters<typeof executeReplanSliceWithInvocation>[0],
  basePath: string,
) {
  return executeReplanSliceWithInvocation(params, basePath, internalPlanningInvocation());
}

function executeReassessRoadmap(
  params: Parameters<typeof executeReassessRoadmapWithInvocation>[0],
  basePath: string,
) {
  return executeReassessRoadmapWithInvocation(params, basePath, internalPlanningInvocation());
}

let sliceLifecycleInvocationSequence = 0;

function sliceLifecycleInvocation(operation: "complete" | "reopen" | "skip"): ExecutionInvocation {
  sliceLifecycleInvocationSequence += 1;
  return internalExecutionInvocation(
    `test/workflow-tool-executors/slice-${operation}/${sliceLifecycleInvocationSequence}`,
  );
}

function executeSliceComplete(
  params: Parameters<typeof executeSliceCompleteWithInvocation>[0],
  basePath: string,
  invocation = sliceLifecycleInvocation("complete"),
) {
  return executeSliceCompleteWithInvocation(params, basePath, invocation);
}

function executeSliceReopen(
  params: Parameters<typeof executeSliceReopenWithInvocation>[0],
  basePath: string,
  invocation = sliceLifecycleInvocation("reopen"),
) {
  return executeSliceReopenWithInvocation(params, basePath, invocation);
}

function executeSkipSlice(
  params: Parameters<typeof executeSkipSliceWithInvocation>[0],
  basePath: string,
  invocation = sliceLifecycleInvocation("skip"),
) {
  return executeSkipSliceWithInvocation(params, basePath, invocation);
}

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-workflow-executors-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

function openTestDb(base: string): void {
  openDatabase(join(normalizeRealPath(base), ".gsd", "gsd.db"));
}

async function inProjectDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

test("closeout executors reject phase escalation from the wrong active auto unit", async () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = "/tmp/project";
  autoSession.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

  try {
    const slice = await executeSliceComplete({} as Parameters<typeof executeSliceComplete>[0], "/tmp/project");
    assert.equal(slice.isError, true);
    assert.match(String(slice.details.error), /complete_slice may only run from complete-slice/);

    const validate = await executeValidateMilestone({} as Parameters<typeof executeValidateMilestone>[0], "/tmp/project");
    assert.equal(validate.isError, true);
    assert.match(String(validate.details.error), /validate_milestone may only run from validate-milestone/);

    const milestone = await executeCompleteMilestone({} as Parameters<typeof executeCompleteMilestone>[0], "/tmp/project");
    assert.equal(milestone.isError, true);
    assert.match(String(milestone.details.error), /complete_milestone may only run from complete-milestone/);

    const uat = await executeUatResultSave({} as Parameters<typeof executeUatResultSave>[0], "/tmp/project");
    assert.equal(uat.isError, true);
    assert.match(String(uat.details.error), /save_uat_result may only run from run-uat/);
    assert.match(String(uat.details.error), /Tool Contract failure/);
  } finally {
    autoSession.reset();
  }
});

function seedMilestone(milestoneId: string, title: string, status = "active"): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run(milestoneId, title, status, new Date().toISOString());
}

function validMilestonePlan(milestoneId = "M001"): Parameters<typeof executePlanMilestone>[0] {
  return {
    milestoneId,
    title: "Workflow MCP planning",
    vision: "Plan milestone over shared executors.",
    slices: [
      {
        sliceId: "S01",
        title: "Bridge planning",
        risk: "medium",
        depends: [],
        demo: "Milestone plan persists through MCP.",
        goal: "Persist roadmap state.",
        successCriteria: "ROADMAP.md renders from DB.",
        proofLevel: "integration",
        integrationClosure: "Prompts and MCP call the same handler.",
        observabilityImpact: "Executor tests cover output paths.",
      },
    ],
  };
}

function seedSlice(milestoneId: string, sliceId: string, status: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO slices (milestone_id, id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(milestoneId, sliceId, `Slice ${sliceId}`, status, new Date().toISOString());
}

function seedCompletedTaskAuthority(input: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  runId: string;
}): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, completed_at, sequence)
    VALUES (?, ?, ?, ?, 'pending', NULL, 1)
    ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
      status = 'pending', completed_at = NULL
  `).run(input.milestoneId, input.sliceId, input.taskId, `Task ${input.taskId}`);
  seedSliceCompletionAuthority({
    milestoneId: input.milestoneId,
    sliceId: input.sliceId,
    completedTaskIds: [input.taskId],
    runId: input.runId,
  });
}

function writeRoadmap(base: string, milestoneId: string, sliceIds: string[]): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  const lines = [
    `# ${milestoneId}: Workflow MCP planning`,
    "",
    "## Slices",
    "",
    ...sliceIds.map((sliceId) => `- [ ] **${sliceId}: Slice ${sliceId}** \`risk:medium\` \`depends:[]\`\n  - After this: demo`),
    "",
  ];
  writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), lines.join("\n"));
}

test("executeSummarySave persists artifact and returns computed path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "SUMMARY",
      content: "# Summary\n\ncontent",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.path, "phases/01-m001/01-01-SUMMARY.md");

    const filePath = join(base, ".gsd", "phases", "01-m001", "01-01-SUMMARY.md");
    assert.ok(existsSync(filePath), "summary artifact should be written to disk");
    assert.match(readFileSync(filePath, "utf-8"), /# Summary/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave task summaries use the canonical projection seam", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  seedSlice("M001", "S01", "in_progress");
  mkdirSync(join(base, ".gsd", "phases", "01-foundation"), { recursive: true });

  const result = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    artifact_type: "SUMMARY",
    content: "# T01 Summary\n\nCanonical task output.\n",
  }, base));

  const artifactPath = "phases/01-foundation/S01-T01-SUMMARY.md";
  const fileContent = readFileSync(join(base, ".gsd", artifactPath), "utf-8");
  assert.notEqual(result.isError, true);
  assert.equal(result.details.path, artifactPath);
  assert.match(fileContent, /<!-- gsd:state-version=\d+:\d+ -->/);
  assert.equal(getArtifact(artifactPath)?.full_content, fileContent);
});

test("executeSummarySave surfaces task summary projection failures", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  seedSlice("M001", "S01", "in_progress");
  const artifactPath = "phases/01-foundation/S01-T01-SUMMARY.md";
  mkdirSync(join(base, ".gsd", artifactPath), { recursive: true });

  const result = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    artifact_type: "SUMMARY",
    content: "# T01 Summary\n\nMust not report success.\n",
  }, base));

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Error saving artifact/);
  assert.equal(getArtifact(artifactPath), null);
});

test("executeSummarySave surfaces task summary worktree mirror failures", async (t) => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/M001\n");
  openTestDb(base);
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  seedSlice("M001", "S01", "in_progress");
  mkdirSync(join(base, ".gsd", "phases", "01-foundation"), { recursive: true });
  const artifactPath = "phases/01-foundation/S01-T01-SUMMARY.md";
  mkdirSync(join(worktree, ".gsd", artifactPath), { recursive: true });

  const result = await inProjectDir(worktree, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    artifact_type: "SUMMARY",
    content: "# T01 Summary\n\nMirror failure must be visible.\n",
  }, worktree));

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Error saving artifact/);
  assert.ok(getArtifact(artifactPath));
});

test("executeSummarySave persists UI-SPEC artifacts at the computed flat-phase path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "UI-SPEC",
      content: "# UI Spec\n\nDesign contract.",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.path, "phases/01-m001/01-01-UI-SPEC.md");
    assert.equal(result.details.artifact_type, "UI-SPEC");

    const filePath = join(base, ".gsd", "phases", "01-m001", "01-01-UI-SPEC.md");
    assert.ok(existsSync(filePath), "UI-SPEC artifact should be written to disk");
    assert.match(readFileSync(filePath, "utf-8"), /Design contract/);
    assert.equal(getArtifact("phases/01-m001/01-01-UI-SPEC.md")?.artifact_type, "UI-SPEC");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

function completeSliceRow(milestoneId: string, sliceId: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "UPDATE slices SET status = 'complete', completed_at = ? WHERE milestone_id = ? AND id = ?",
  ).run(new Date().toISOString(), milestoneId, sliceId);
}

test("executeSummarySave persists UAT artifacts to the slice UAT carrier", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  seedSlice("M001", "S01", "in_progress");

  const result = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S01",
    artifact_type: "UAT",
    content: "# UAT\n\nAcceptance: 5 units verified\n",
  }, base));

  assert.notEqual(result.isError, true);
  assert.equal(result.details.operation, "save_summary");
  assert.equal(result.details.path, "phases/01-m001/01-01-UAT.md");
  assert.equal(result.details.artifact_type, "UAT");

  // CRITICAL: UAT content lands in the UAT carrier, never the summary carrier.
  const slice = getSlice("M001", "S01");
  assert.equal(slice?.full_uat_md, "# UAT\n\nAcceptance: 5 units verified\n");
  assert.equal(slice?.full_summary_md, "", "UAT saves must not touch full_summary_md");

  const filePath = join(base, ".gsd", "phases", "01-m001", "01-01-UAT.md");
  assert.ok(existsSync(filePath), "UAT artifact should be written to disk");
  assert.match(readFileSync(filePath, "utf-8"), /Acceptance: 5 units/);
  assert.equal(getArtifact("phases/01-m001/01-01-UAT.md")?.artifact_type, "UAT");
});

test("executeSummarySave UAT correction re-renders a completed slice's UAT projection", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  seedSlice("M001", "S01", "in_progress");
  // Simulate completion output: the carriers hold the pre-correction UAT text.
  setSliceSummaryMd(
    "M001",
    "S01",
    "# Slice summary",
    "# UAT\n\nAcceptance: 5 units verified\n\n## Evidence\n- unit A: pass\n- unit B: pass\n",
  );
  completeSliceRow("M001", "S01");

  // Initial flush: the DB-owned projection renders the pre-correction text.
  const firstFlush = await renderAllFromDb(base);
  assert.deepEqual(firstFlush.errors, []);
  const uatPath = join(base, ".gsd", "phases", "01-foundation", "01-01-UAT.md");
  assert.ok(existsSync(uatPath), "completed slice should project its UAT file");
  assert.match(readFileSync(uatPath, "utf-8"), /Acceptance: 5 units/);

  const result = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S01",
    artifact_type: "UAT",
    content: "# UAT\n\nAcceptance: 7 units verified (superseded by S02)\n\n## Evidence\n- unit A: pass\n- unit B: pass\n- unit C: pass\n",
  }, base));
  assert.notEqual(result.isError, true);
  assert.equal(result.details.path, "phases/01-foundation/01-01-UAT.md");

  // Post-completion flush: the correction must survive — no silent revert.
  const secondFlush = await renderAllFromDb(base);
  assert.deepEqual(secondFlush.errors, []);
  const rendered = readFileSync(uatPath, "utf-8");
  assert.match(rendered, /Acceptance: 7 units verified/);
  assert.doesNotMatch(rendered, /Acceptance: 5 units/);

  const slice = getSlice("M001", "S01");
  assert.match(slice?.full_uat_md ?? "", /Acceptance: 7 units verified/);
  assert.equal(slice?.full_summary_md, "# Slice summary", "summary carrier must be untouched");
});

test("executeSummarySave rejects UAT saves without a usable slice target", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  seedSlice("M001", "S01", "in_progress");

  const noSliceId = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    artifact_type: "UAT",
    content: "# UAT\n",
  }, base));
  assert.equal(noSliceId.isError, true);
  assert.equal(noSliceId.details.error, "missing_slice_id");

  const withTaskId = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    artifact_type: "UAT",
    content: "# UAT\n",
  }, base));
  assert.equal(withTaskId.isError, true);
  assert.equal(withTaskId.details.error, "unexpected_task_id");

  const unknownSlice = await inProjectDir(base, () => executeSummarySave({
    milestone_id: "M001",
    slice_id: "S09",
    artifact_type: "UAT",
    content: "# UAT\n",
  }, base));
  assert.equal(unknownSlice.isError, true);
  assert.equal(unknownSlice.details.error, "slice_not_found");
});

test("executeSummarySave mirrors milestone artifacts into the active worktree projection", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  try {
    mkdirSync(join(worktree, ".gsd"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/M001\n");
    openTestDb(base);

    const result = await inProjectDir(worktree, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S02",
      artifact_type: "RESEARCH",
      content: "# S02 Research\n\ncanonical and worktree",
    }, worktree));

    assert.equal(result.details.operation, "save_summary");
    const relPath = "phases/01-m001/01-02-RESEARCH.md";
    const projectPath = join(base, ".gsd", relPath);
    const worktreePath = join(worktree, ".gsd", relPath);
    assert.equal(existsSync(projectPath), true, "canonical artifact should be written");
    assert.equal(existsSync(worktreePath), true, "active worktree projection should be mirrored");
    assert.match(readFileSync(worktreePath, "utf-8"), /S02 Research/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeTaskComplete coerces string verificationEvidence entries", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Demo** `est:5m`\n");

    const result = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
      verification: "npm test",
      verificationEvidence: ["npm test"],
    }, base));

    assert.equal(result.details.operation, "complete_task");
    assert.equal(result.details.taskId, "T01");

    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const rows = db!.prepare(
      "SELECT command, exit_code, verdict, duration_ms FROM verification_evidence WHERE milestone_id = ? AND slice_id = ? AND task_id = ?",
    ).all("M001", "S01", "T01") as Array<Record<string, unknown>>;

    assert.equal(rows.length, 1, "one coerced verification evidence row should be inserted");
    assert.equal(rows[0]["command"], "npm test");
    assert.equal(rows[0]["exit_code"], -1);
    assert.match(String(rows[0]["verdict"]), /coerced from string/);

    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "task summary should be written to disk");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeTaskComplete derives missing verification from evidence", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Demo** `est:5m`\n");

    const result = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
      verificationEvidence: [
        { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 },
      ],
    }, base));

    assert.equal(result.details.operation, "complete_task");
    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const row = db!.prepare(
      "SELECT verification_result FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).get("M001", "S01", "T01") as Record<string, unknown> | undefined;

    assert.match(String(row?.verification_result), /Verification evidence recorded/);
    assert.match(String(row?.verification_result), /`npm test` exited 0 \(pass\)/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeTaskComplete treats a malformed duplicate for an already-complete task as idempotent", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Demo** `est:5m`\n");

    const first = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
      verification: "npm test",
    }, base));
    assert.ok(!first.isError, "the well-formed call should complete the task");

    // Parallel duplicate from the same turn: no verification, no evidence, no
    // blocker. Must not trip the fail-closed guard now that the task is closed.
    const duplicate = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
    } as Parameters<typeof executeTaskComplete>[0], base));

    assert.ok(!duplicate.isError, "duplicate completion should not be an error");
    assert.equal(duplicate.details.error, undefined);
    assert.equal(duplicate.details.duplicate, true);
    assert.equal(duplicate.details.summaryPath, first.details.summaryPath);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeTaskComplete creates the legacy escalation directory and surfaces its metadata", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), [
      "---",
      "version: 1",
      "phases:",
      "  mid_execution_escalation: true",
      "---",
    ].join("\n"));
    const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Demo** `est:5m`\n");

    const result = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work but found an ambiguity.",
      verification: "npm test",
      escalation: {
        question: "Should the cache use write-through or write-back?",
        options: [
          { id: "A", label: "Write-through", tradeoffs: "Simpler reads; slower writes." },
          { id: "B", label: "Write-back", tradeoffs: "Faster writes; more flush complexity." },
        ],
        recommendation: "A",
        recommendationRationale: "Current usage favors correctness over write latency.",
        continueWithDefault: true,
      },
    }, base));

    assert.equal(result.details.operation, "complete_task");
    assert.match(
      String(result.content[0]?.text),
      /Task completed with escalation decision required: Should the cache use write-through or write-back\?/,
    );
    assert.match(String(result.content[0]?.text), /Resolve with: \/gsd escalate resolve T01/);
    assert.equal((result.details.escalation as { question?: string }).question, "Should the cache use write-through or write-back?");

    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const row = db!.prepare(
      "SELECT escalation_pending, escalation_awaiting_review, escalation_artifact_path FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).get("M001", "S01", "T01") as Record<string, unknown> | undefined;
    assert.equal(row?.escalation_pending, 0);
    assert.equal(row?.escalation_awaiting_review, 1);
    const expectedArtifactPath = join(normalizeRealPath(planDir), "tasks", "T01-ESCALATION.json");
    assert.equal(row?.escalation_artifact_path, expectedArtifactPath);
    assert.equal(existsSync(expectedArtifactPath), true);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeTaskComplete surfaces stale readable status and duplicate repair metadata", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  openTestDb(base);
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), [
    "---",
    "version: 1",
    "phases:",
    "  mid_execution_escalation: true",
    "---",
  ].join("\n"));
  const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    join(planDir, "S01-PLAN.md"),
    "# S01\n\n- [ ] **T01: Ordinary** `est:5m`\n- [ ] **T02: Escalated** `est:5m`\n",
  );

  const roadmapPath = join(base, ".gsd", "ROADMAP.md");
  mkdirSync(roadmapPath);
  const ordinaryParams = {
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    oneLiner: "Completed ordinary task",
    narrative: "Did the ordinary work.",
    verification: "Focused test passed.",
  };
  const ordinary = await inProjectDir(base, () => executeTaskComplete(ordinaryParams, base));

  assert.equal(ordinary.isError, undefined);
  assert.equal(ordinary.details.stale, true);
  assert.match(String(ordinary.content[0]?.text), /readable status update is pending repair/i);

  const escalated = await inProjectDir(base, () => executeTaskComplete({
    ...ordinaryParams,
    taskId: "T02",
    oneLiner: "Completed escalated task",
    escalation: {
      question: "Which publication route should be used?",
      options: [
        { id: "A", label: "Direct", tradeoffs: "Simple and immediate." },
        { id: "B", label: "Queued", tradeoffs: "More durable but delayed." },
      ],
      recommendation: "A",
      recommendationRationale: "The direct route is sufficient here.",
      continueWithDefault: true,
    },
  }, base));

  assert.equal(escalated.isError, undefined);
  assert.equal(escalated.details.stale, true);
  assert.match(String(escalated.content[0]?.text), /readable status update is pending repair/i);

  // The obstruction gate refuses to journal a write over the foreign ROADMAP.md
  // directory, so the retry converges once the obstruction is cleared
  // externally — and provably left no unbound recovery evidence behind.
  discardProjectionEvidence(base);
  rmSync(roadmapPath, { recursive: true });
  removeProjectionFileSync(String(ordinary.details.summaryPath));
  const repaired = await inProjectDir(base, () => executeTaskComplete(ordinaryParams, base));

  assert.equal(repaired.isError, undefined);
  assert.equal(repaired.details.duplicate, true);
  assert.equal(repaired.details.stale, undefined);
  assert.doesNotMatch(String(repaired.content[0]?.text), /pending repair/i);
  assert.equal(existsSync(roadmapPath), true, "same-task retry must repair the readable roadmap");
});

test("executeTaskComplete returns a tool error when verification cannot be derived", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
    }, base));

    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text), /verification is required/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSliceComplete preserves omitted optional requirement arrays", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M001",
      title: "Requirement preservation",
      vision: "Ensure omitted arrays are not coerced to empties.",
      slices: [
        {
          sliceId: "S01",
          title: "Slice",
          risk: "medium",
          depends: [],
          demo: "demo",
          goal: "goal",
          successCriteria: "done",
          proofLevel: "integration",
          integrationClosure: "closed",
          observabilityImpact: "covered",
        },
      ],
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M001",
      sliceId: "S01",
      goal: "goal",
      tasks: [
        {
          taskId: "T01",
          title: "Task",
          description: "desc",
          estimate: "5m",
          files: ["src/a.ts"],
          verify: "node --test",
          inputs: ["in"],
          expectedOutput: ["out"],
        },
      ],
    }, base));
    seedCompletedTaskAuthority({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      runId: "requirement-preservation-initial",
    });

    const result = await inProjectDir(base, () => executeSliceComplete({
      milestoneId: "M001",
      sliceId: "S01",
      sliceTitle: "Slice",
      oneLiner: "done",
      narrative: "done",
      verification: "ok",
      uatContent: "ok",
      requirementsAdvanced: [{ id: "R010", how: "advanced" }],
      requirementsValidated: [{ id: "R010", proof: "validated" }],
    }, base));

    assert.equal(result.details.operation, "complete_slice");
    const summaryPath = String(result.details.summaryPath);
    const summary = readFileSync(summaryPath, "utf-8");
    assert.match(summary, /R010 — advanced/);
    assert.match(summary, /R010 — validated/);

    const reopenResult = await inProjectDir(base, () => executeSliceReopen({
      milestoneId: "M001",
      sliceId: "S01",
      reason: "validate idempotent overwrite behavior",
    }, base));
    assert.equal(reopenResult.details.operation, "reopen_slice");
    seedCompletedTaskAuthority({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      runId: "requirement-preservation-redo",
    });

    const recallResult = await inProjectDir(base, () => executeSliceComplete({
      milestoneId: "M001",
      sliceId: "S01",
      sliceTitle: "Slice",
      oneLiner: "done (updated)",
      narrative: "done (updated)",
      verification: "ok",
      uatContent: "ok",
    }, base));

    assert.equal(recallResult.details.operation, "complete_slice");
    const recallSummaryPath = String(recallResult.details.summaryPath);
    const recallSummary = readFileSync(recallSummaryPath, "utf-8");
    assert.match(
      recallSummary,
      /R010 — advanced/,
      "requirementsAdvanced should be preserved from first call",
    );
    assert.match(
      recallSummary,
      /R010 — validated/,
      "requirementsValidated should be preserved from first call",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSliceComplete surfaces committed projection obstruction as pending readable status", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M001", "Projection obstruction");
  seedSlice("M001", "S01", "active");
  seedCompletedTaskAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    runId: "slice-complete-projection-obstruction",
  });
  const summaryPath = join(base, relSliceFile(base, "M001", "S01", "SUMMARY"));
  mkdirSync(summaryPath, { recursive: true });

  const result = await inProjectDir(base, () => executeSliceComplete({
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Projection obstruction",
    oneLiner: "Completion committed before rendering.",
    narrative: "The database remains authoritative while readable status is repaired.",
    verification: "Focused authority tests passed.",
    uatContent: "## Result\n\nPassed.",
  }, base));

  assert.equal(result.isError, undefined);
  assert.equal(result.details.operation, "complete_slice");
  assert.equal(result.details.stale, true);
  assert.match(String(result.content[0]?.text), /readable status update.*pending/i);
});

test("executeSliceReopen surfaces cleanup obstruction and repairs it on the same invocation", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M001", "Reopen projection obstruction");
  seedSlice("M001", "S01", "active");
  seedCompletedTaskAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    runId: "slice-reopen-projection-obstruction",
  });
  const completed = await inProjectDir(base, () => executeSliceComplete({
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Reopen projection obstruction",
    oneLiner: "Completion committed before reopen.",
    narrative: "The readable completion will be obstructed during reopen.",
    verification: "Focused authority tests passed.",
    uatContent: "## Result\n\nPassed.",
  }, base));
  const summaryPath = String(completed.details.summaryPath);
  rmSync(summaryPath, { force: true });
  mkdirSync(summaryPath);
  const invocation = sliceLifecycleInvocation("reopen");

  const obstructed = await inProjectDir(base, () => executeSliceReopen({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Redo the Slice with updated requirements.",
  }, base, invocation));

  assert.equal(obstructed.isError, undefined);
  assert.equal(obstructed.details.operation, "reopen_slice");
  assert.equal(obstructed.details.stale, true);
  assert.match(String(obstructed.content[0]?.text), /readable status update.*pending/i);

  rmSync(summaryPath, { recursive: true, force: true });
  const repaired = await inProjectDir(base, () => executeSliceReopen({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Redo the Slice with updated requirements.",
  }, base, invocation));

  assert.equal(repaired.details.stale, undefined);
  assert.equal(
    Number(_getAdapter()!.prepare(`
      SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.reopen'
    `).get()?.["count"] ?? 0),
    1,
  );
});

test("historical slice completion replay never presents superseded completion as current", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M001", "Historical lifecycle replay");
  seedSlice("M001", "S01", "active");
  seedCompletedTaskAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    runId: "historical-lifecycle-first-completion",
  });
  const completionInvocation = sliceLifecycleInvocation("complete");
  const completionParams = {
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Historical lifecycle replay",
    oneLiner: "First completion.",
    narrative: "This completion will later be superseded by a reopen.",
    verification: "Focused authority tests passed.",
    uatContent: "## Result\n\nPassed.",
  };
  const firstCompletion = await inProjectDir(base, () => executeSliceComplete(
    completionParams,
    base,
    completionInvocation,
  ));
  assert.equal(firstCompletion.isError, undefined);

  const reopenParams = {
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Redo the Slice with updated requirements.",
  };
  const firstReopen = await inProjectDir(base, () => executeSliceReopen(
    reopenParams,
    base,
  ));
  assert.equal(firstReopen.isError, undefined);

  const historicalCompletion = await inProjectDir(base, () => executeSliceComplete(
    completionParams,
    base,
    completionInvocation,
  ));

  assert.doesNotMatch(String(historicalCompletion.content[0]?.text), /^Completed slice\b/i);
  assert.match(
    String(historicalCompletion.content[0]?.text),
    /historical|superseded|no longer current/i,
  );
  assert.equal(historicalCompletion.isError, undefined);
  assert.equal(historicalCompletion.details.duplicate, true);
  assert.equal(historicalCompletion.details.superseded, true);
});

test("historical slice reopen replay never presents superseded reopen as current", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M001", "Historical reopen replay");
  seedSlice("M001", "S01", "active");
  seedCompletedTaskAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    runId: "historical-reopen-first-completion",
  });
  const completionParams = {
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Historical reopen replay",
    oneLiner: "First completion.",
    narrative: "This completion will be reopened and completed again.",
    verification: "Focused authority tests passed.",
    uatContent: "## Result\n\nPassed.",
  };
  const firstCompletion = await inProjectDir(base, () => executeSliceComplete(
    completionParams,
    base,
  ));
  assert.equal(firstCompletion.isError, undefined);

  const reopenInvocation = sliceLifecycleInvocation("reopen");
  const reopenParams = {
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Redo the Slice with updated requirements.",
  };
  const firstReopen = await inProjectDir(base, () => executeSliceReopen(
    reopenParams,
    base,
    reopenInvocation,
  ));
  assert.equal(firstReopen.isError, undefined);

  seedCompletedTaskAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    runId: "historical-reopen-second-completion",
  });
  const currentCompletion = await inProjectDir(base, () => executeSliceComplete({
    ...completionParams,
    oneLiner: "Second completion.",
    narrative: "This completion supersedes the earlier reopen.",
  }, base));
  assert.equal(currentCompletion.isError, undefined);

  const historicalReopen = await inProjectDir(base, () => executeSliceReopen(
    reopenParams,
    base,
    reopenInvocation,
  ));

  assert.doesNotMatch(String(historicalReopen.content[0]?.text), /^Reopened slice\b/i);
  assert.match(
    String(historicalReopen.content[0]?.text),
    /historical|superseded|no longer current/i,
  );
  assert.equal(historicalReopen.isError, undefined);
  assert.equal(historicalReopen.details.duplicate, true);
  assert.equal(historicalReopen.details.superseded, true);
});

test("executeSkipSlice surfaces projection obstruction and retries the full readable projection set", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M001", "Skip projection obstruction");
  seedSlice("M001", "S01", "active");
  _getAdapter()!.prepare(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES ('M001', 'S01', 'T01', 'Pending task', 'pending', 1)
  `).run();
  mkdirSync(join(base, ".gsd", "STATE.md"), { recursive: true });
  const invocation = sliceLifecycleInvocation("skip");

  const obstructed = await inProjectDir(base, () => executeSkipSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "The Slice is no longer required.",
  }, base, invocation));

  assert.equal(obstructed.isError, undefined);
  assert.equal(obstructed.details.operation, "skip_slice");
  assert.equal(obstructed.details.stale, true);
  assert.match(String(obstructed.content[0]?.text), /readable status update.*pending/i);

  const roadmapPath = join(base, ".gsd", "ROADMAP.md");
  assert.equal(existsSync(roadmapPath), true, "an obstructed write must not block independent projection writes");
  // The obstruction gate refuses to journal a write over the foreign STATE.md
  // directory, so the retry converges once the obstruction is cleared
  // externally — and provably left no unbound recovery evidence behind.
  discardProjectionEvidence(base);
  rmSync(join(base, ".gsd", "STATE.md"), { recursive: true, force: true });
  rmSync(roadmapPath, { force: true });
  const repaired = await inProjectDir(base, () => executeSkipSlice({
    milestoneId: "M001",
    sliceId: "S01",
    reason: "The Slice is no longer required.",
  }, base, invocation));

  assert.equal(repaired.details.stale, undefined);
  assert.equal(existsSync(join(base, ".gsd", "STATE.md")), true);
  assert.equal(existsSync(roadmapPath), true, "retry must repair a non-STATE readable projection");
  assert.match(readFileSync(roadmapPath, "utf8"), /M001: Skip projection obstruction/);
  assert.equal(
    Number(_getAdapter()!.prepare(`
      SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'slice.cancel'
    `).get()?.["count"] ?? 0),
    1,
  );
});

test("executeMilestoneStatus returns milestone metadata and slice counts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "active");
    const db = _getAdapter();
    db!.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
    ).run("M001", "S01", "T01", "Task T01", "pending");

    const result = await inProjectDir(base, () => executeMilestoneStatus({ milestoneId: "M001" }, base));
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.milestoneId, "M001");
    assert.equal(parsed.title, "Milestone One");
    assert.equal(parsed.sliceCount, 1);
    assert.deepEqual(parsed.dependsOn, []);
    assert.equal(parsed.slices[0].id, "S01");
    assert.equal(parsed.slices[0].taskCounts.pending, 1);
    assert.equal(result.details.status, "active");
    assert.equal(result.details.title, "Milestone One");
    assert.deepEqual(result.details.dependsOn, []);
    assert.deepEqual(result.details.slices, parsed.slices);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeMilestoneStatus returns persisted milestone dependencies", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M009", "Milestone Nine");
    seedMilestone("M010", "Milestone Ten");
    _getAdapter()!.prepare("UPDATE milestones SET depends_on = ? WHERE id = ?")
      .run(JSON.stringify(["M009"]), "M010");

    const result = await inProjectDir(base, () => executeMilestoneStatus({ milestoneId: "M010" }, base));
    const parsed = JSON.parse(result.content[0].text);

    assert.deepEqual(parsed.dependsOn, ["M009"]);
    assert.deepEqual(result.details.dependsOn, ["M009"]);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone writes roadmap state and rendered roadmap path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan(), base));

    assert.equal(result.details.operation, "plan_milestone");
    assert.equal(result.details.milestoneId, "M001");
    const roadmapPath = String(result.details.roadmapPath);
    assert.ok(existsSync(roadmapPath), "roadmap should be rendered to disk");
    assert.match(readFileSync(roadmapPath, "utf-8"), /Workflow MCP planning/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone refuses a same-milestone lease conflict", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Existing holder");
    const holder = registerAutoWorker({ projectRootRealpath: join(base, "other-project") });
    _getAdapter()!.prepare("UPDATE workers SET pid = :pid WHERE worker_id = :worker_id")
      .run({ ":pid": process.pid + 1, ":worker_id": holder });
    const lease = claimMilestoneLease(holder, "M001");
    assert.equal(lease.ok, true);

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M001"), base));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "plan_milestone");
    assert.equal(result.details.error, "milestone_lease_conflict");
    assert.match(result.content[0].text, /Milestone M001 is currently leased/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone releases its one-shot milestone lease after planning", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Existing milestone");

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M001"), base));

    assert.equal(result.isError, undefined);
    const lease = getMilestoneLease("M001");
    assert.ok(lease, "planning should participate in milestone lease coordination");
    assert.equal(lease.status, "released");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone creates a fresh milestone without a one-shot lease", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M042"), base));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.operation, "plan_milestone");
    assert.equal(result.details.milestoneId, "M042");
    assert.equal(getMilestoneLease("M042"), null,
      "fresh milestone creation must pass through without creating a lease row");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone does not create a placeholder when fresh planning validation fails", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    // handlePlanMilestone rejects empty slice arrays during validation. Fresh
    // milestone creation must pass through without pre-inserting a leaseable
    // placeholder row.
    const invalid = { ...validMilestonePlan("M042"), slices: [] };
    const result = await inProjectDir(base, () => executePlanMilestone(invalid, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "plan_milestone");
    const milestones = getAllMilestones();
    assert.equal(milestones.find(m => m.id === "M042"), undefined,
      "failed fresh planning must not leave a milestone row behind");
    assert.equal(getMilestoneLease("M042"), null,
      "failed fresh planning must not create a lease row");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone does not delete a peer worker's milestone row on lease conflict", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    // Simulate a peer process that has already
    // created the milestone row and taken its lease. The one-shot executor
    // must observe the active lease and refuse — without removing the peer's
    // milestone row or lease. The pre-rollback bug was that
    // INSERT OR IGNORE's silent no-op was treated as proof of authorship and
    // the cleanup path then deleted the peer's row.
    const peer = registerAutoWorker({ projectRootRealpath: join(base, "peer-project") });
    _getAdapter()!.prepare("UPDATE workers SET pid = :pid WHERE worker_id = :worker_id")
      .run({ ":pid": process.pid + 1, ":worker_id": peer });
    seedMilestone("M050", "Peer-owned milestone");
    const peerLease = claimMilestoneLease(peer, "M050");
    assert.equal(peerLease.ok, true);
    const peerLeaseToken = peerLease.ok ? peerLease.token : -1;

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M050"), base));

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "milestone_lease_conflict");
    const peerMilestone = getAllMilestones().find(m => m.id === "M050");
    assert.ok(peerMilestone, "peer milestone row must survive the one-shot conflict path");
    assert.equal(peerMilestone?.title, "Peer-owned milestone",
      "peer milestone row must not be clobbered or recreated");
    const surviving = getMilestoneLease("M050");
    assert.ok(surviving, "peer lease row must survive");
    assert.equal(surviving.status, "held", "peer must still hold the lease");
    assert.equal(surviving.worker_id, peer);
    assert.equal(surviving.fencing_token, peerLeaseToken,
      "peer's fencing token must not be incremented by the rejected one-shot");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone refuses when a foreign active worker holds the lease even while in-process auto is active", async () => {
  const base = makeTmpBase();
  autoSession.reset();
  try {
    openTestDb(base);
    seedMilestone("M060", "Foreign-held milestone");

    // In-process auto must still reject a lease held by another worker.
    const foreign = registerAutoWorker({ projectRootRealpath: join(base, "foreign-project") });
    _getAdapter()!.prepare("UPDATE workers SET pid = :pid WHERE worker_id = :worker_id")
      .run({ ":pid": process.pid + 1, ":worker_id": foreign });
    const foreignLease = claimMilestoneLease(foreign, "M060");
    assert.equal(foreignLease.ok, true);
    const foreignToken = foreignLease.ok ? foreignLease.token : -1;

    const ownAutoWorker = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
    autoSession.active = true;
    autoSession.workerId = ownAutoWorker;

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M060"), base));

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "milestone_lease_conflict",
      "in-process auto must NOT skip lease checks when the lease is held by a different active worker");
    const surviving = getMilestoneLease("M060");
    assert.ok(surviving);
    assert.equal(surviving.status, "held");
    assert.equal(surviving.worker_id, foreign);
    assert.equal(surviving.fencing_token, foreignToken,
      "foreign worker's fencing token must not be incremented by the rejected call");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone proceeds without re-claiming when in-process auto holds the lease itself", async () => {
  const base = makeTmpBase();
  autoSession.reset();
  try {
    openTestDb(base);
    seedMilestone("M070", "Auto-held milestone");

    // In-process auto should not re-claim its own lease and bump its token.
    const ownAutoWorker = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
    const heldLease = claimMilestoneLease(ownAutoWorker, "M070");
    assert.equal(heldLease.ok, true);
    const heldToken = heldLease.ok ? heldLease.token : -1;
    autoSession.active = true;
    autoSession.workerId = ownAutoWorker;

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M070"), base));

    assert.equal(result.isError, undefined, `auto's own plan-milestone call should succeed: ${result.content?.[0]?.text}`);
    const surviving = getMilestoneLease("M070");
    assert.ok(surviving);
    assert.equal(surviving.status, "held", "auto's lease must still be held after the planning call");
    assert.equal(surviving.worker_id, ownAutoWorker);
    assert.equal(surviving.fencing_token, heldToken,
      "auto's fencing token must not be incremented by an in-process plan call");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone reclaims a same-process holder after active auto resumes in a milestone worktree", async () => {
  const base = makeTmpBase();
  autoSession.reset();
  try {
    openTestDb(base);
    seedMilestone("M080", "Same-process holder");
    const worktree = join(base, ".gsd-worktrees", "M080");
    mkdirSync(worktree, { recursive: true });
    const staleWorker = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
    const heldLease = claimMilestoneLease(staleWorker, "M080");
    assert.equal(heldLease.ok, true);
    const heldToken = heldLease.ok ? heldLease.token : -1;

    autoSession.active = true;
    autoSession.workerId = registerAutoWorker({ projectRootRealpath: normalizeRealPath(worktree) });

    const result = await inProjectDir(worktree, () => executePlanMilestone(validMilestonePlan("M080"), worktree));

    assert.equal(result.isError, undefined,
      `same-process auto resume must not conflict with its prior worker ID: ${result.content?.[0]?.text}`);
    const surviving = getMilestoneLease("M080");
    assert.ok(surviving, "reclaimed lease must remain held by active auto");
    assert.equal(surviving.worker_id, autoSession.workerId);
    assert.ok(surviving.fencing_token > heldToken,
      "same-process resume must bump the fencing token when reclaiming the lease");
    assert.equal(surviving.status, "held");
    assert.equal(autoSession.milestoneLeaseToken, surviving.fencing_token);
    assert.equal(getAutoWorker(staleWorker)?.status, "stopping");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone refuses a same-process holder when active auto has no worker row", async () => {
  const base = makeTmpBase();
  autoSession.reset();
  try {
    openTestDb(base);
    seedMilestone("M081", "Detached auto worker");
    const holderWorker = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
    const heldLease = claimMilestoneLease(holderWorker, "M081");
    assert.equal(heldLease.ok, true);
    const heldToken = heldLease.ok ? heldLease.token : -1;

    // A setup-race pause detaches the worker from the session while auto stays
    // active; there is nothing to reclaim with, so planning must fail closed.
    autoSession.active = true;
    autoSession.workerId = null;

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M081"), base));

    assert.equal(result.isError, true);
    assert.equal(result.details?.error, "milestone_lease_conflict");
    const surviving = getMilestoneLease("M081");
    assert.ok(surviving, "holder lease must survive the refused plan call");
    assert.equal(surviving.worker_id, holderWorker);
    assert.equal(surviving.fencing_token, heldToken);
    assert.equal(surviving.status, "held");
    assert.equal(getAutoWorker(holderWorker)?.status, "active");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone takes over a stale same-process lease via reentry instead of waiting for TTL", async () => {
  const base = makeTmpBase();
  autoSession.reset();
  try {
    openTestDb(base);
    seedMilestone("M080", "Stale-locked milestone");

    // One-shot planning should reach claimMilestoneLease so its same-process
    // reentry clause can recover stale worker rows.
    const staleWorker = registerAutoWorker({ projectRootRealpath: normalizeRealPath(base) });
    const staleLease = claimMilestoneLease(staleWorker, "M080");
    assert.equal(staleLease.ok, true);
    const staleToken = staleLease.ok ? staleLease.token : -1;

    const result = await inProjectDir(base, () => executePlanMilestone(validMilestonePlan("M080"), base));

    assert.equal(result.isError, undefined,
      `same-process reentry takeover must succeed, not return milestone_lease_conflict: ${result.content?.[0]?.text}`);
    const after = getMilestoneLease("M080");
    assert.ok(after, "lease row must remain after takeover + release");
    assert.equal(after.status, "released", "the executor releases its own claim before returning");
    assert.notEqual(after.worker_id, staleWorker,
      "lease must be owned by the new worker after takeover");
    assert.ok(after.fencing_token > staleToken,
      `fencing token must monotonically advance on takeover (was ${staleToken}, now ${after.fencing_token})`);
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanSlice writes task planning state and rendered plan artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone(validMilestonePlan(), base));

    const result = await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Persist slice plan over MCP.",
      tasks: [
        {
          taskId: "T01",
          title: "Add planning bridge",
          description: "Implement the shared executor path.",
          estimate: "15m",
          files: ["src/resources/extensions/gsd/tools/workflow-tool-executors.ts"],
          verify: "node --test",
          inputs: [],
          expectedOutput: ["src/bridge-status.md"],
        },
      ],
    }, base));

    assert.equal(result.details.operation, "plan_slice");
    assert.equal(result.details.sliceId, "S01");
    const planPath = String(result.details.planPath);
    assert.ok(existsSync(planPath), "slice plan should be rendered to disk");
    assert.match(readFileSync(planPath, "utf-8"), /Persist slice plan over MCP/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanSlice replay preserves public paths across project path aliases", async () => {
  const base = makeTmpBase();
  const alias = `${base}-alias`;
  try {
    symlinkSync(base, alias, process.platform === "win32" ? "junction" : "dir");
    openTestDb(base);
    await inProjectDir(alias, () => executePlanMilestone(validMilestonePlan(), alias));

    const params = {
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Preserve exact replay responses.",
      tasks: [
        {
          taskId: "T01",
          title: "Keep replay paths stable",
          description: "Return the same public paths for an exact retry.",
          estimate: "15m",
          files: ["src/resources/extensions/gsd/tools/plan-slice.ts"],
          verify: "node --test",
          inputs: [],
          expectedOutput: ["src/replay-path-status.md"],
        },
      ],
    };
    const invocation = internalPlanningInvocation();
    const first = await inProjectDir(alias, () =>
      executePlanSliceWithInvocation(params, alias, invocation));
    const replay = await inProjectDir(base, () =>
      executePlanSliceWithInvocation(params, base, invocation));

    assert.deepEqual(replay, first, "an exact replay must preserve its public response");
  } finally {
    closeDatabase();
    try { unlinkSync(alias); } catch { /* swallow */ }
    cleanup(base);
  }
});

test("executePlanSlice accepts metadata-only incremental planning payloads", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone(validMilestonePlan(), base));

    const result = await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Persist slice metadata before tasks.",
      tasks: [],
    }, base));

    assert.equal(result.details.operation, "plan_slice");
    assert.equal(result.details.sliceId, "S01");
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Planned slice S01/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave accepts gsd_uat_exec evidence written in a milestone worktree", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const browserTimelineDir = join(base, ".artifacts", "browser", "session");
  const evidenceId = "worktree-uat-evidence";
  const browserTimelinePath = join(browserTimelineDir, "s02-uat-browser-timeline.json");
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S02", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    mkdirSync(browserTimelineDir, { recursive: true });
    writeFileSync(browserTimelinePath, JSON.stringify({ summary: "browser timeline evidence" }), "utf-8");
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S02",
          checkId: "UAT-01",
          intent: "uat-runtime-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S02",
      uatType: "runtime-executable",
      verdict: "PASS",
      checks: [{
        id: "UAT-01",
        description: "Runtime path C:\\tmp|uat evidence was captured in the active worktree",
        mode: "runtime",
        result: "PASS",
        evidence: [
          { kind: "gsd_uat_exec", ref: evidenceId },
          { kind: "browser", ref: browserTimelinePath },
        ],
        notes: "Worktree-local gsd_uat_exec metadata should resolve with backslash \\ and pipe |.",
      }],
      presentation: {
        surface: "mcp",
        presentedTools: [
          "gsd_uat_exec",
          "gsd_uat_result_save",
          "gsd_resume",
          "gsd_milestone_status",
          "gsd_journal_query",
        ],
        blockedTools: [
          { name: "gsd_exec", reason: "forbidden during run-uat" },
          { name: "gsd_summary_save", reason: "forbidden during run-uat" },
          { name: "gsd_save_gate_result", reason: "forbidden during run-uat" },
        ],
      },
      notes: "UAT passed with worktree-local evidence.",
    }, worktree));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.operation, "save_uat_result");
    assert.equal(result.details.verdict, "PASS");
    assert.equal(result.details.runId, "uat:M001:S02:attempt-1");
    assert.equal(result.details.worktreeRoot, worktree);
    assert.equal(result.details.browserToolsPresented, false);
    assert.ok(
      existsSync(join(base, ".gsd", "uat", "M001", "S02", "attempt-1.json")),
      "attempt JSON should be persisted under the authoritative project .gsd",
    );
    const attempt = JSON.parse(readFileSync(
      join(base, ".gsd", "uat", "M001", "S02", "attempt-1.json"),
      "utf-8",
    )) as {
      runId?: string;
      worktreeRoot?: string;
      browserToolsPresented?: boolean;
      modePolicy?: { requiredAnyModes?: string[] };
    };
    assert.equal(attempt.runId, "uat:M001:S02:attempt-1");
    assert.equal(attempt.worktreeRoot, worktree);
    assert.equal(attempt.browserToolsPresented, false);
    assert.deepEqual(attempt.modePolicy?.requiredAnyModes, ["runtime"]);
    const assessment = readFileSync(
      join(base, ".gsd", "phases", "01-m001", "01-02-ASSESSMENT.md"),
      "utf-8",
    );
    assert.match(assessment, /runId: uat:M001:S02:attempt-1/);
    assert.ok(assessment.includes(`worktreeRoot: ${worktree}`));
    assert.match(assessment, /Runtime path C:\\\\tmp\\\|uat evidence/);
    assert.match(assessment, /backslash \\\\ and pipe \\\|/);

    const artifactPath = "phases/01-m001/01-02-ASSESSMENT.md";
    const assessmentPath = `.gsd/${artifactPath}`;
    assert.equal(getArtifact(artifactPath)?.artifact_type, "ASSESSMENT");
    assert.equal(getAssessment(assessmentPath)?.scope, "run-uat");
    assert.equal(getAssessment(assessmentPath)?.status, "pass");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave leaves UAT pending after a harness-aborted turn", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "harness-aborted-uat-evidence";
  const startedAt = Date.now();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S04", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S04",
          checkId: "UAT-01",
          intent: "uat-runtime-check",
        },
      }),
      "utf-8",
    );
    _getAdapter()!.prepare(
      `INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("M001", "S04", "UAT", "slice", "", "pending");
    autoSession.reset();
    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: "run-uat", id: "M001/S04", startedAt, workspaceRoot: worktree };
    recordUnitHarnessAbort(base, "run-uat", "M001/S04", startedAt, {
      kind: "tool-loop-guard",
      reason: "Tool loop detected (repeated tool): browser_click called 7 times this turn.",
      toolName: "browser_click",
      count: 7,
    });

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S04",
      uatType: "runtime-executable",
      verdict: "FAIL",
      checks: [{
        id: "UAT-01",
        description: "Runtime behavior could not be fully evaluated before harness abort",
        mode: "runtime",
        result: "FAIL",
        evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        notes: "Partial failure should be retried because the harness aborted the turn.",
      }],
      presentation: {
        surface: "mcp",
        presentedTools: [
          "gsd_uat_exec",
          "gsd_uat_result_save",
          "gsd_resume",
          "gsd_milestone_status",
          "gsd_journal_query",
        ],
        blockedTools: [
          { name: "gsd_exec", reason: "forbidden during run-uat" },
          { name: "gsd_summary_save", reason: "forbidden during run-uat" },
          { name: "gsd_save_gate_result", reason: "forbidden during run-uat" },
        ],
      },
      notes: "Partial UAT result after harness abort.",
    }, worktree));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "save_uat_result");
    assert.equal(result.details.error, "harness_aborted_needs_retry");
    assert.equal(result.details.retryable, true);
    assert.equal(result.details.harnessAbortKind, "tool-loop-guard");
    assert.equal(
      existsSync(join(base, ".gsd", "uat", "M001", "S04", "attempt-1.json")),
      false,
      "harness-aborted UAT should not persist an attempt artifact",
    );
    assert.equal(
      existsSync(join(base, ".gsd", "phases", "01-m001", "01-04-ASSESSMENT.md")),
      false,
      "harness-aborted UAT should not write an ASSESSMENT verdict",
    );
    const row = _getAdapter()!.prepare(
      "SELECT status, verdict FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ?",
    ).get("M001", "S04", "UAT") as Record<string, unknown>;
    assert.equal(row.status, "pending");
    assert.equal(row.verdict, "");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave supplies canonical presentation and normalizes verdict casing", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "uat-lowercase-verdict";
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S03", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S03",
          checkId: "UAT-01",
          intent: "uat-artifact-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S03",
      uatType: "artifact-driven",
      verdict: "pass",
      checks: [{
        id: "UAT-01",
        description: "Static artifact contract passes",
        mode: "artifact",
        result: "PASS",
        evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        notes: "Artifact check passed.",
      }],
      notes: "UAT passed with canonical presentation supplied by the executor.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.verdict, "PASS");

    const attempt = JSON.parse(readFileSync(
      join(base, ".gsd", "uat", "M001", "S03", "attempt-1.json"),
      "utf-8",
    )) as { presentation?: { toolPresentationPlanId?: string; presentedTools?: string[] } };
    assert.equal(attempt.presentation?.toolPresentationPlanId, "run-uat/default-v1");
    assert.ok(attempt.presentation?.presentedTools?.includes("gsd_uat_result_save"));
    assert.ok(attempt.presentation?.presentedTools?.includes("read"));
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave supplies direct browser tools for browser-executable UAT", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "uat-direct-browser-evidence";
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S06", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S06",
          checkId: "UAT-01",
          intent: "uat-browser-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S06",
      uatType: "browser-executable",
      verdict: "PASS",
      checks: [{
        id: "UAT-01",
        description: "Browser flow used browser tools",
        mode: "browser",
        result: "PASS",
        evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        notes: "Browser check passed.",
      }],
      notes: "UAT passed with browser evidence.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, undefined);
    const attempt = JSON.parse(readFileSync(
      join(base, ".gsd", "uat", "M001", "S06", "attempt-1.json"),
      "utf-8",
    )) as { browserToolsPresented?: boolean; presentation?: { presentedTools?: string[] } };

    assert.equal(result.details.browserToolsPresented, true);
    assert.equal(attempt.browserToolsPresented, true);
    assert.ok(attempt.presentation?.presentedTools?.includes("browser_navigate"));
    assert.ok(attempt.presentation?.presentedTools?.includes("browser_assert"));
    assert.equal(
      attempt.presentation?.presentedTools?.some((toolName) => toolName.startsWith("mcp__gsd-browser__")),
      false,
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave merges canonical plan ID and read-only tools when presentation lacks plan ID", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "uat-no-plan-id-evidence";
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S05", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S05",
          checkId: "UAT-01",
          intent: "uat-artifact-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S05",
      uatType: "artifact-driven",
      verdict: "PASS",
      checks: [{
        id: "UAT-01",
        description: "Presentation plan ID absent from provider call",
        mode: "artifact",
        result: "PASS",
        evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        notes: "Canonical merge should apply even when toolPresentationPlanId is absent.",
      }],
      presentation: {
        surface: "mcp",
        presentedTools: [
          "gsd_uat_exec",
          "gsd_uat_result_save",
          "gsd_resume",
          "gsd_milestone_status",
          "gsd_journal_query",
        ],
        blockedTools: [
          { name: "gsd_exec", reason: "forbidden during run-uat" },
          { name: "gsd_summary_save", reason: "forbidden during run-uat" },
          { name: "gsd_save_gate_result", reason: "forbidden during run-uat" },
        ],
      },
      notes: "Provider omitted toolPresentationPlanId; executor must canonicalize.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.verdict, "PASS");

    const attempt = JSON.parse(readFileSync(
      join(base, ".gsd", "uat", "M001", "S05", "attempt-1.json"),
      "utf-8",
    )) as { presentation?: { toolPresentationPlanId?: string; presentedTools?: string[] } };
    assert.equal(attempt.presentation?.toolPresentationPlanId, "run-uat/default-v1");
    assert.ok(attempt.presentation?.presentedTools?.includes("read"), "read-only tool must be merged in");
    assert.ok(attempt.presentation?.presentedTools?.includes("gsd_uat_result_save"));
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave surfaces the worktree validation path and notification for NEEDS-HUMAN checks", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "uat-human-validation-evidence";
  try {
    openTestDb(base);
    initNotificationStore(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S07", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S07",
          checkId: "UAT-01",
          intent: "uat-runtime-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S07",
      uatType: "human-experience",
      verdict: "PASS",
      checks: [
        {
          id: "UAT-01",
          description: "Service boots and renders the dashboard",
          mode: "runtime",
          result: "PASS",
          evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
          notes: "Boot check passed.",
        },
        {
          id: "UAT-02",
          description: "Dashboard layout feels balanced",
          mode: "human-follow-up",
          result: "NEEDS-HUMAN",
          nonAutomatable: true,
          notes: "Open the app and eyeball the spacing.",
        },
      ],
      notes: "Automatable checks passed; layout taste needs a human.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.verdict, "PASS");
    // The reviewer needs the buried worktree checkout path, not just the file.
    assert.equal(result.details.manualValidationPath, worktree);
    const returnedText = (result.content[0] as { text: string }).text;
    assert.match(returnedText, /Manual validation needed/);
    assert.ok(returnedText.includes(worktree), "tool return should include the worktree path");

    const assessment = readFileSync(
      join(base, ".gsd", "phases", "01-m001", "01-07-ASSESSMENT.md"),
      "utf-8",
    );
    assert.match(assessment, /## Manual Validation/);
    assert.ok(assessment.includes(worktree), "assessment should include the worktree checkout path");
    assert.match(assessment, /git worktree/);

    const notifications = readNotifications(base, { kind: "uat-needs-human", scope: "M001/S07" });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].severity, "warning");
    assert.equal(notifications[0].source, "notify");
    assert.equal(
      notifications[0].message,
      "UAT for M001/S07 has NEEDS-HUMAN checks awaiting human validation",
    );
  } finally {
    _resetNotificationStore();
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave omits manual-validation guidance when no human checks remain", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "uat-no-human-evidence";
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S08", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S08",
          checkId: "UAT-01",
          intent: "uat-artifact-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S08",
      uatType: "artifact-driven",
      verdict: "PASS",
      checks: [{
        id: "UAT-01",
        description: "Config file exists",
        mode: "artifact",
        result: "PASS",
        evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
        notes: "Artifact present.",
      }],
      notes: "Fully automated pass.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.manualValidationPath, undefined);
    const returnedText = (result.content[0] as { text: string }).text;
    assert.equal(returnedText.includes("Manual validation needed"), false);

    const assessment = readFileSync(
      join(base, ".gsd", "phases", "01-m001", "01-08-ASSESSMENT.md"),
      "utf-8",
    );
    assert.equal(assessment.includes("## Manual Validation"), false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave rejects saved UAT without fresh UAT-owned evidence", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  const evidenceId = "generic-exec-evidence";
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S04", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: { kind: "exec" },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S04",
      uatType: "artifact-driven",
      verdict: "PASS",
      checks: [{
        id: "UAT-01",
        description: "Static artifact contract passes",
        mode: "artifact",
        result: "PASS",
        evidence: [{ kind: "gsd_exec", ref: evidenceId }],
        notes: "Generic evidence should not satisfy fresh UAT evidence.",
      }],
      notes: "UAT should not pass without fresh UAT-owned evidence.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text), /fresh gsd_uat_exec evidence/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave rejects an unrecognized uatType", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  try {
    openTestDb(base);
    mkdirSync(worktree, { recursive: true });
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S06", "complete");

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S06",
      uatType: "hallucinated-mode",
      verdict: "PASS",
      checks: [{
        id: "UAT-01",
        description: "Static artifact contract passes",
        mode: "artifact",
        result: "PASS",
        evidence: [{ kind: "gsd_uat_exec", ref: "some-ref" }],
      }],
      notes: "Should fail before evidence validation.",
    } as unknown as Parameters<typeof executeUatResultSave>[0], worktree));

    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text), /uatType must be one of/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeUatResultSave rejects artifact-driven PASS with human follow-up checks", async () => {
  const base = makeTmpBase();
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const evidenceId = "uat-artifact-nonautomatable";
  const worktreeExecDir = join(worktree, ".gsd", "exec");
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "complete");
    mkdirSync(worktreeExecDir, { recursive: true });
    writeFileSync(
      join(worktreeExecDir, `${evidenceId}.meta.json`),
      JSON.stringify({
        id: evidenceId,
        metadata: {
          kind: "uat_exec",
          milestoneId: "M001",
          sliceId: "S01",
          checkId: "UAT-01",
          intent: "uat-artifact-check",
        },
      }),
      "utf-8",
    );

    const result = await inProjectDir(worktree, () => executeUatResultSave({
      milestoneId: "M001",
      sliceId: "S01",
      uatType: "artifact-driven",
      verdict: "PASS",
      checks: [
        {
          id: "UAT-01",
          description: "Static contract passes",
          mode: "artifact",
          result: "PASS",
          evidence: [{ kind: "gsd_uat_exec", ref: evidenceId }],
          notes: "Artifact check passed.",
        },
        {
          id: "UAT-02",
          description: "Browser polish is deferred to the next slice",
          mode: "human-follow-up",
          result: "NEEDS-HUMAN",
          notes: "Out of scope for this artifact-driven UAT.",
          nonAutomatable: true,
        },
      ],
      presentation: {
        surface: "mcp",
        presentedTools: [
          "gsd_uat_exec",
          "gsd_uat_result_save",
          "gsd_resume",
          "gsd_milestone_status",
          "gsd_journal_query",
        ],
        blockedTools: [
          { name: "gsd_exec", reason: "forbidden during run-uat" },
          { name: "gsd_summary_save", reason: "forbidden during run-uat" },
          { name: "gsd_save_gate_result", reason: "forbidden during run-uat" },
        ],
      },
      notes: "UAT passed; non-automatable browser polish is deferred.",
    }, worktree));

    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text), /artifact-driven UAT cannot PASS with human-only checks/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSliceComplete coerces string enrichment entries and writes summary/UAT artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "pending");
    writeRoadmap(base, "M001", ["S01"]);
    seedCompletedTaskAuthority({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      runId: "string-enrichment",
    });

    const rawParams = {
      milestoneId: "M001",
      sliceId: "S01",
      sliceTitle: "Slice S01",
      oneLiner: "Completed slice",
      narrative: "Implemented the slice",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS",
      provides: "shared executor path",
      requirementsAdvanced: ["R001 - added slice completion support"],
      filesModified: ["src/file.ts - updated logic"],
      requires: ["S00 - upstream context"],
    } as unknown as Parameters<typeof executeSliceComplete>[0];

    const result = await inProjectDir(base, () => executeSliceComplete(rawParams, base));

    assert.equal(result.details.operation, "complete_slice");
    const summaryPath = String(result.details.summaryPath);
    const uatPath = String(result.details.uatPath);
    assert.ok(existsSync(summaryPath), "slice summary should be written to disk");
    assert.ok(existsSync(uatPath), "slice UAT should be written to disk");
    assert.match(readFileSync(summaryPath, "utf-8"), /shared executor path/);
    assert.match(readFileSync(summaryPath, "utf-8"), /R001/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSliceComplete normalizes requirement object aliases (how -> proof/what)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "pending");
    writeRoadmap(base, "M001", ["S01"]);
    seedCompletedTaskAuthority({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      runId: "requirement-aliases",
    });

    const rawParams = {
      milestoneId: "M001",
      sliceId: "S01",
      sliceTitle: "Slice S01",
      oneLiner: "Completed slice",
      narrative: "Implemented the slice",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS",
      requirementsValidated: [{ id: "R010", how: "Integration test passed" }],
      requirementsInvalidated: [{ id: "R011", how: "Scope narrowed" }],
    } as unknown as Parameters<typeof executeSliceComplete>[0];

    const result = await inProjectDir(base, () => executeSliceComplete(rawParams, base));
    assert.equal(result.details.operation, "complete_slice");
    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "slice summary should be written to disk");
    const summary = readFileSync(summaryPath, "utf-8");
    assert.match(summary, /R010 — Integration test passed/);
    assert.match(summary, /R011 — Scope narrowed/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeValidateMilestone persists validation artifact and gate records", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M002", "Milestone Two");
    seedSlice("M002", "S02", "complete");

    const result = await inProjectDir(base, () => executeValidateMilestone({
      milestoneId: "M002",
      verdict: "pass",
      remediationRound: 0,
      successCriteriaChecklist: "- [x] Works",
      sliceDeliveryAudit: "| Slice | Result |\n| --- | --- |\n| S02 | pass |",
      crossSliceIntegration: "No cross-slice issues.",
      requirementCoverage: "All requirements covered.",
      verdictRationale: "Everything passed.",
    }, base));

    assert.equal(result.details.operation, "validate_milestone");
    const validationPath = String(result.details.validationPath);
    assert.ok(existsSync(validationPath), "validation file should be written to disk");

    const db = _getAdapter();
    const gates = db!.prepare(
      "SELECT gate_id, verdict FROM quality_gates WHERE milestone_id = ? ORDER BY gate_id",
    ).all("M002") as Array<Record<string, unknown>>;
    assert.ok(gates.length > 0, "validation should seed milestone quality gates");
    assert.equal(gates[0]["verdict"], "pass");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeValidateMilestone rejects verificationClasses that omit planned Operational class", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M002", "Milestone Two");
    const db = _getAdapter();
    db!.prepare("UPDATE milestones SET verification_operational = ? WHERE id = ?").run(
      "Camoufox subprocess lifecycle/cleanup proof",
      "M002",
    );
    seedSlice("M002", "S02", "complete");

    const result = await inProjectDir(base, () => executeValidateMilestone({
      milestoneId: "M002",
      verdict: "pass",
      remediationRound: 0,
      successCriteriaChecklist: "- [x] Works",
      sliceDeliveryAudit: "| Slice | Result |\n| --- | --- |\n| S02 | pass |",
      crossSliceIntegration: "No cross-slice issues.",
      requirementCoverage: "All requirements covered.",
      verificationClasses: "| Check | Result |\n| --- | --- |\n| Generic verification | PASS |",
      verdictRationale: "Everything passed.",
    }, base));

    assert.equal(result.isError, true);
    assert.match(String(result.details.error), /must include canonical row "Operational"/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeCompleteMilestone sanitizes raw params and writes milestone summary", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M003", "Milestone Three");
    seedSlice("M003", "S03", "complete");
    writeRoadmap(base, "M003", ["S03"]);
    const db = _getAdapter();
    db!.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
    ).run("M003", "S03", "T03", "Task T03", "complete");
    insertAssessment({
      path: join(".gsd", "milestones", "M003", "M003-VALIDATION.md"),
      milestoneId: "M003",
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nValidated.",
    });

    const rawParams = {
      milestoneId: "M003",
      title: "Milestone Three",
      oneLiner: "Completed milestone",
      narrative: "Everything shipped.",
      verificationPassed: "true",
      keyDecisions: ["shared executor path"],
      lessonsLearned: ["MCP transport stays generic"],
    } as unknown as Parameters<typeof executeCompleteMilestone>[0];

    const result = await inProjectDir(base, () => executeCompleteMilestone(rawParams, base));

    assert.equal(result.details.operation, "complete_milestone");
    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "milestone summary should be written to disk");
    assert.match(readFileSync(summaryPath, "utf-8"), /shared executor path/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeCompleteMilestone returns success for already-complete milestones without overwriting the existing summary", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M003", "Milestone Three", "complete");
    seedSlice("M003", "S03", "complete");
    writeRoadmap(base, "M003", ["S03"]);
    const milestoneDir = join(base, ".gsd", "milestones", "M003");
    mkdirSync(milestoneDir, { recursive: true });
    const summaryPath = join(milestoneDir, "M003-SUMMARY.md");
    writeFileSync(summaryPath, "# Existing Summary\n");

    const result = await inProjectDir(base, () => executeCompleteMilestone({
      milestoneId: "M003",
      title: "Milestone Three",
      oneLiner: "Completed milestone",
      narrative: "Everything shipped.",
      verificationPassed: true,
    }, base));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.operation, "complete_milestone");
    assert.equal(result.details.alreadyComplete, true);
    assert.match(result.content[0].text, /already complete/);
    assert.doesNotMatch(result.content[0].text, /Summary written to/);
    assert.equal(readFileSync(summaryPath, "utf-8"), "# Existing Summary\n");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeCompleteMilestone recovers a managed summary projection failure", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M003", "Milestone Three");
  seedSlice("M003", "S03", "complete");
  _getAdapter()!.prepare(
    "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
  ).run("M003", "S03", "T03", "Task T03", "complete");
  insertAssessment({
    path: join(".gsd", "milestones", "M003", "M003-VALIDATION.md"),
    milestoneId: "M003",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nValidated.",
  });
  const summaryPath = targetMilestoneFile(base, "M003", "SUMMARY", "Milestone Three");
  let summaryWriteBlocked = false;
  t.after(() => _setManagedProjectionApplyFaultForTest(null));
  _setManagedProjectionApplyFaultForTest(() => {
    summaryWriteBlocked = true;
    _setManagedProjectionApplyFaultForTest(null);
    throw new Error("simulated milestone summary projection failure");
  });

  const result = await inProjectDir(base, () => executeCompleteMilestone({
    milestoneId: "M003",
    title: "Milestone Three",
    oneLiner: "Completed milestone",
    narrative: "Everything shipped.",
    verificationPassed: true,
  }, base));

  assert.equal(result.isError, undefined);
  assert.equal(summaryWriteBlocked, true, "fixture must obstruct the milestone SUMMARY write itself");
  assert.equal(existsSync(summaryPath), true, "the managed flush must recover the retained summary mutation");
  assert.equal(result.details.stale, undefined);
  assert.doesNotMatch(String(result.content[0]?.text), /readable status update is pending repair/i);
  assert.match(String(result.content[0]?.text), /summary (?:written|available)/i);
});

test("executeCompleteMilestone surfaces stale readable status while a managed summary projection failure persists", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M003", "Milestone Three");
  seedSlice("M003", "S03", "complete");
  _getAdapter()!.prepare(
    "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
  ).run("M003", "S03", "T03", "Task T03", "complete");
  insertAssessment({
    path: join(".gsd", "milestones", "M003", "M003-VALIDATION.md"),
    milestoneId: "M003",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nValidated.",
  });
  const summaryPath = targetMilestoneFile(base, "M003", "SUMMARY", "Milestone Three");
  // Managed projection writes go through the native journal boundary, not
  // fsPromises.rename, so obstructing the rename seam no longer obstructs the
  // SUMMARY write. Fault the managed write seam itself, scoped to exactly the
  // milestone SUMMARY logical path, on every attempt.
  const summaryLogicalPath = relative(
    join(normalizeRealPath(base), ".gsd"),
    summaryPath,
  ).replaceAll("\\", "/");
  const obstructedWrites: string[] = [];
  _setManagedProjectionWriteFaultForTest((logicalPath) => {
    if (logicalPath !== summaryLogicalPath) return;
    obstructedWrites.push(logicalPath);
    throw new Error("simulated milestone summary projection failure");
  });
  t.after(() => _setManagedProjectionWriteFaultForTest(null));

  const result = await inProjectDir(base, () => executeCompleteMilestone({
    milestoneId: "M003",
    title: "Milestone Three",
    oneLiner: "Completed milestone",
    narrative: "Everything shipped.",
    verificationPassed: true,
  }, base));

  assert.equal(result.isError, undefined);
  assert.ok(obstructedWrites.length > 0, "fixture must obstruct the milestone SUMMARY write itself");
  assert.deepEqual([...new Set(obstructedWrites)], [summaryLogicalPath]);
  assert.equal(existsSync(summaryPath), false);
  assert.equal(result.details.stale, true);
  assert.match(String(result.content[0]?.text), /readable status update is pending repair/i);
  assert.doesNotMatch(String(result.content[0]?.text), /summary (?:written|available)/i);
});

test("executeReassessRoadmap writes assessment and updates roadmap projection", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M004",
      title: "Milestone Four",
      vision: "Exercise roadmap reassessment.",
      slices: [
        {
          sliceId: "S04",
          title: "Completed slice",
          risk: "medium",
          depends: [],
          demo: "Completed slice works",
          goal: "Complete the first slice.",
          successCriteria: "S04 is complete.",
          proofLevel: "integration",
          integrationClosure: "Baseline flow is wired.",
          observabilityImpact: "Executor test covers reassessment.",
        },
        {
          sliceId: "S05",
          title: "Follow-up slice",
          risk: "medium",
          depends: ["S04"],
          demo: "Follow-up slice is adjusted",
          goal: "Handle the follow-up work.",
          successCriteria: "Roadmap gets updated.",
          proofLevel: "integration",
          integrationClosure: "Downstream work stays aligned.",
          observabilityImpact: "Assessment artifact is rendered.",
        },
      ],
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M004",
      sliceId: "S04",
      goal: "Complete the first slice.",
      tasks: [
        {
          taskId: "T04",
          title: "Finish slice",
          description: "Close the completed slice.",
          estimate: "5m",
          files: ["src/file.ts"],
          verify: "node --test",
          inputs: ["M004-ROADMAP.md"],
          expectedOutput: ["S04-SUMMARY.md", "S04-UAT.md"],
        },
      ],
    }, base));
    seedCompletedTaskAuthority({
      milestoneId: "M004",
      sliceId: "S04",
      taskId: "T04",
      runId: "roadmap-reassessment",
    });
    await inProjectDir(base, () => executeSliceComplete({
      milestoneId: "M004",
      sliceId: "S04",
      sliceTitle: "Completed slice",
      oneLiner: "Completed slice",
      narrative: "Slice finished.",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS",
    }, base));

    const result = await inProjectDir(base, () => executeReassessRoadmap({
      milestoneId: "M004",
      completedSliceId: "S04",
      verdict: "roadmap-adjusted",
      assessment: "Added a remediation slice.",
      sliceChanges: {
        modified: [
          {
            sliceId: "S05",
            title: "Adjusted follow-up slice",
            risk: "high",
            depends: ["S04"],
            demo: "Adjusted follow-up demo",
          },
        ],
        added: [
          {
            sliceId: "S06",
            title: "Remediation slice",
            risk: "medium",
            depends: ["S05"],
            demo: "Remediation slice demo",
          },
        ],
        removed: [],
      },
    }, base));

    assert.equal(result.details.operation, "reassess_roadmap");
    const assessmentPath = String(result.details.assessmentPath);
    const roadmapPath = String(result.details.roadmapPath);
    assert.ok(existsSync(assessmentPath), "assessment file should be written");
    assert.ok(existsSync(roadmapPath), "roadmap should be re-rendered");
    assert.match(readFileSync(roadmapPath, "utf-8"), /S06/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSaveGateResult validates inputs and persists verdicts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M005", "Milestone Five");
    seedSlice("M005", "S05", "pending");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "gate.ts"), "export const gate = true;\n", "utf-8");
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M005",
      sliceId: "S05",
      goal: "Plan gate save projection.",
      tasks: [
        {
          taskId: "T01",
          title: "Add gate fixture",
          description: "Create a fixture touched by gate evaluation.",
          estimate: "10m",
          files: ["src/gate.ts"],
          verify: "node --test",
          inputs: [],
          expectedOutput: ["src/gate.ts"],
        },
      ],
    }, base));

    const result = await inProjectDir(base, () => executeSaveGateResult({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      verdict: "pass",
      rationale: "Looks good.",
      findings: "No issues found.",
    }, base));

    assert.equal(result.details.operation, "save_gate_result");
    const db = _getAdapter();
    const row = db!.prepare(
      "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''",
    ).get("M005", "S05", "Q3") as Record<string, unknown> | undefined;
    assert.equal(row?.status, "complete");
    assert.equal(row?.verdict, "pass");
    assert.equal(row?.rationale, "Looks good.");
    // Flat-phase: M005 title "Milestone Five" → phases/05-milestone-five/05-05-PLAN.md
    const planPath = join(base, ".gsd", "phases", "05-milestone-five", "05-05-PLAN.md");
    assert.match(readFileSync(planPath, "utf-8"), /No issues found\./);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSaveGateResult succeeds after committing a gate for a skipped slice", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M005", "Milestone Five");
  seedSlice("M005", "S05", "skipped");
  _getAdapter()!.prepare(
    "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
  ).run("M005", "S05", "T01", "Skipped task", "skipped");
  insertGateRow({ milestoneId: "M005", sliceId: "S05", gateId: "Q3", scope: "slice" });

  const result = await inProjectDir(base, () => executeSaveGateResult({
    milestoneId: "M005",
    sliceId: "S05",
    gateId: "Q3",
    verdict: "omitted",
    rationale: "Slice was intentionally skipped.",
    findings: "",
  }, base));

  assert.equal(result.isError, undefined);
  assert.equal(result.details.operation, "save_gate_result");
  assert.equal(result.details.stale, undefined);
  assert.deepEqual(_getAdapter()!.prepare(
    `SELECT status, verdict, rationale FROM quality_gates
     WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''`,
  ).get("M005", "S05", "Q3"), {
    status: "complete",
    verdict: "omitted",
    rationale: "Slice was intentionally skipped.",
  });
});

test("executeSaveGateResult reports a post-commit projection failure as stale success", async (t) => {
  const base = makeTmpBase();
  t.after(() => {
    _setManagedProjectionWriteFaultForTest(null);
    closeDatabase();
    cleanup(base);
  });
  openTestDb(base);
  seedMilestone("M005", "Milestone Five");
  seedSlice("M005", "S05", "pending");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "gate.ts"), "export const gate = true;\n", "utf-8");
  await inProjectDir(base, () => executePlanSlice({
    milestoneId: "M005",
    sliceId: "S05",
    goal: "Exercise a failed post-save plan projection.",
    tasks: [{
      taskId: "T01",
      title: "Keep one active task",
      description: "Keep the plan render path active.",
      estimate: "5m",
      files: ["src/gate.ts"],
      verify: "node --test",
      inputs: [],
      expectedOutput: ["src/gate.ts"],
    }],
  }, base));
  const obstructedWrites: string[] = [];
  _setManagedProjectionWriteFaultForTest((logicalPath) => {
    if (!logicalPath.endsWith("-PLAN.md")) return;
    obstructedWrites.push(logicalPath);
    throw new Error("simulated gate plan projection failure");
  });

  const result = await inProjectDir(base, () => executeSaveGateResult({
    milestoneId: "M005",
    sliceId: "S05",
    gateId: "Q3",
    verdict: "pass",
    rationale: "The gate itself passed.",
    findings: "No gate findings.",
  }, base));

  assert.equal(result.isError, undefined);
  assert.equal(result.details.operation, "save_gate_result");
  assert.equal(result.details.stale, true);
  assert.match(String(result.content[0]?.text), /saved.*readable plan update is pending repair/i);
  assert.ok(obstructedWrites.length > 0, "fixture must obstruct the post-save PLAN write");
  assert.deepEqual(_getAdapter()!.prepare(
    `SELECT status, verdict FROM quality_gates
     WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''`,
  ).get("M005", "S05", "Q3"), {
    status: "complete",
    verdict: "pass",
  });
});

test("executeSaveGateResult leaves quality gates pending after a retryable tool error", async () => {
  const base = makeTmpBase();
  const startedAt = Date.now();
  try {
    openTestDb(base);
    seedMilestone("M005", "Milestone Five");
    seedSlice("M005", "S05", "pending");
    insertGateRow({ milestoneId: "M005", sliceId: "S05", gateId: "Q3", scope: "slice" });
    autoSession.reset();
    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: "plan-slice", id: "M005/S05", startedAt };
    recordUnitHarnessAbort(base, "plan-slice", "M005/S05", startedAt, {
      kind: "tool-error",
      reason: "Input validation error: selector is required",
      toolName: "browser_click",
    });

    const result = await inProjectDir(base, () => executeSaveGateResult({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      verdict: "flag",
      rationale: "Partial gate failure after harness abort.",
      findings: "This should not be persisted as a product-quality finding.",
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "save_gate_result");
    assert.equal(result.details.error, "harness_aborted_needs_retry");
    assert.equal(result.details.retryable, true);
    assert.equal(result.details.harnessAbortKind, "tool-error");
    const row = _getAdapter()!.prepare(
      "SELECT status, verdict, rationale, findings FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''",
    ).get("M005", "S05", "Q3") as Record<string, unknown>;
    assert.equal(row.status, "pending");
    assert.equal(row.verdict, "");
    assert.equal(row.rationale, "");
    assert.equal(row.findings, "");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executeSaveGateResult leaves quality gates pending after a turn abort", async () => {
  const base = makeTmpBase();
  const startedAt = Date.now();
  try {
    openTestDb(base);
    seedMilestone("M005", "Milestone Five");
    seedSlice("M005", "S05", "pending");
    insertGateRow({ milestoneId: "M005", sliceId: "S05", gateId: "Q3", scope: "slice" });
    autoSession.reset();
    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.currentUnit = { type: "plan-slice", id: "M005/S05", startedAt };
    recordUnitHarnessAbort(base, "plan-slice", "M005/S05", startedAt, {
      kind: "turn-abort",
      reason: "Agent turn aborted before the gate evaluation completed. origin=timeout stopReason=aborted",
    });

    const result = await inProjectDir(base, () => executeSaveGateResult({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      verdict: "flag",
      rationale: "Partial gate failure after a turn abort.",
      findings: "This should not be persisted as a product-quality finding.",
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "save_gate_result");
    assert.equal(result.details.error, "harness_aborted_needs_retry");
    assert.equal(result.details.retryable, true);
    assert.equal(result.details.harnessAbortKind, "turn-abort");
    const row = _getAdapter()!.prepare(
      "SELECT status, verdict, rationale, findings FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''",
    ).get("M005", "S05", "Q3") as Record<string, unknown>;
    assert.equal(row.status, "pending");
    assert.equal(row.verdict, "");
    assert.equal(row.rationale, "");
    assert.equal(row.findings, "");
  } finally {
    autoSession.reset();
    closeDatabase();
    cleanup(base);
  }
});

test("executeSaveGateResult fails when no canonical gate row is updated", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M005", "Milestone Five");
    seedSlice("M005", "S05", "pending");

    const result = await inProjectDir(base, () => executeSaveGateResult({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      verdict: "pass",
      rationale: "Looks good.",
      findings: "No issues found.",
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "save_gate_result");
    assert.match(String(result.details.error), /quality gate row not found/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeReplanSlice rewrites pending tasks and renders replan artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M006",
      title: "Milestone Six",
      vision: "Exercise slice replanning.",
      slices: [
        {
          sliceId: "S06",
          title: "Replan slice",
          risk: "medium",
          depends: [],
          demo: "Slice can be replanned after a blocker task completes.",
          goal: "Prepare replan state.",
          successCriteria: "PLAN and REPLAN artifacts update.",
          proofLevel: "integration",
          integrationClosure: "Replan shares the workflow executor path.",
          observabilityImpact: "Executor test covers replan output files.",
        },
      ],
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M006",
      sliceId: "S06",
      goal: "Plan a slice that will be replanned.",
      tasks: [
        {
          taskId: "T06",
          title: "Blocker task",
          description: "Finish the blocker-discovery task.",
          estimate: "5m",
          files: ["src/blocker.ts"],
          verify: "node --test",
          inputs: ["M006-ROADMAP.md"],
          expectedOutput: ["T06-SUMMARY.md"],
        },
        {
          taskId: "T07",
          title: "Pending task",
          description: "Original follow-up task.",
          estimate: "10m",
          files: ["src/pending.ts"],
          verify: "node --test",
          inputs: ["S06-PLAN.md"],
          expectedOutput: ["Updated plan"],
        },
      ],
    }, base));
    await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M006",
      sliceId: "S06",
      taskId: "T06",
      oneLiner: "Completed blocker task",
      narrative: "The blocker was identified and documented.",
      verification: "node --test",
    }, base));

    const result = await inProjectDir(base, () => executeReplanSlice({
      milestoneId: "M006",
      sliceId: "S06",
      blockerTaskId: "T06",
      blockerDescription: "Original approach no longer works.",
      whatChanged: "Adjusted the remaining tasks and added a remediation task.",
      updatedTasks: [
        {
          taskId: "T07",
          title: "Pending task (updated)",
          description: "Updated follow-up task after replanning.",
          estimate: "15m",
          files: ["src/pending.ts", "src/replanned.ts"],
          verify: "node --test",
          inputs: ["S06-PLAN.md"],
          expectedOutput: ["Updated plan"],
        },
        {
          taskId: "T08",
          title: "Remediation task",
          description: "New task introduced by the replan.",
          estimate: "20m",
          files: ["src/remediation.ts"],
          verify: "node --test",
          inputs: ["S06-REPLAN.md"],
          expectedOutput: ["Remediation patch"],
        },
      ],
      removedTaskIds: [],
    }, base));

    assert.equal(result.details.operation, "replan_slice");
    const planPath = String(result.details.planPath);
    const replanPath = String(result.details.replanPath);
    assert.ok(existsSync(planPath), "replanned plan should exist on disk");
    assert.ok(existsSync(replanPath), "replan artifact should exist on disk");
    assert.match(readFileSync(planPath, "utf-8"), /T08/);
    assert.match(readFileSync(replanPath, "utf-8"), /Adjusted the remaining tasks/);

    const db = _getAdapter();
    const updatedTask = db!.prepare(
      "SELECT title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).get("M006", "S06", "T07") as Record<string, unknown> | undefined;
    const insertedTask = db!.prepare(
      "SELECT title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).get("M006", "S06", "T08") as Record<string, unknown> | undefined;
    assert.equal(updatedTask?.title, "Pending task (updated)");
    assert.equal(insertedTask?.title, "Remediation task");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave removes sibling CONTEXT-DRAFT when writing milestone CONTEXT (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    markDepthVerified("M001", base);

    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const draftPath = join(milestoneDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nincremental notes");
    assert.ok(existsSync(draftPath), "precondition: draft exists");

    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\nfinal discussion output",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.artifact_type, "CONTEXT");

    const contextPath = join(milestoneDir, "M001-CONTEXT.md");
    assert.ok(existsSync(contextPath), "CONTEXT.md should be written");
    assert.equal(
      existsSync(draftPath),
      false,
      "CONTEXT-DRAFT.md should be removed after final CONTEXT.md is written",
    );
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave supports root-level deep planning artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const project = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "A root project artifact.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "",
      ].join("\n"),
    }, base));
    assert.equal(project.isError, undefined);
    assert.equal(project.details.path, "PROJECT.md");
    assert.ok(existsSync(join(base, ".gsd", "PROJECT.md")));

    upsertRequirement({
      id: "R001",
      class: "primary-user-loop",
      status: "active",
      description: "User can add a task",
      why: "Core loop",
      source: "user",
      primary_owner: "M001/none yet",
      supporting_slices: "none",
      validation: "unmapped",
      notes: "",
      full_content: "",
      superseded_by: null,
    });

    const requirements = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n\n## Validated\n\n## Deferred\n\n## Out of Scope\n\n## Traceability\n\n## Coverage Summary\n",
    }, base));
    assert.equal(requirements.isError, undefined);
    assert.equal(requirements.details.path, "REQUIREMENTS.md");
    assert.equal(requirements.details.content_source, "requirements_table");
    assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS.md")));

    const db = _getAdapter();
    const rows = db!.prepare(
      "SELECT path, artifact_type, milestone_id FROM artifacts WHERE path IN ('PROJECT.md', 'REQUIREMENTS.md') ORDER BY path",
    ).all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((row) => [row.path, row.artifact_type, row.milestone_id]),
      [
        ["PROJECT.md", "PROJECT", null],
        ["REQUIREMENTS.md", "REQUIREMENTS", null],
      ],
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave registers PROJECT milestone sequence for the next run", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "Deep project setup output.",
        "",
        "## Project Shape",
        "",
        "**Complexity:** complex",
        "**Why:** It spans multiple delivery steps.",
        "",
        "## Capability Contract",
        "",
        "See .gsd/REQUIREMENTS.md.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "- [ ] M002: Polish - Follow-up experience work.",
        "",
      ].join("\n"),
    }, base));

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details.registeredMilestones, ["M001", "M002"]);

    const milestones = getAllMilestones();
    assert.deepEqual(
      milestones.map((m) => [m.id, m.title, m.status]),
      [
        ["M001", "Foundation", "queued"],
        ["M002", "Polish", "queued"],
      ],
    );

    invalidateStateCache();
    const state = await deriveState(base);
    assert.equal(state.activeMilestone?.id, "M001");
    assert.equal(state.phase, "pre-planning");
    assert.equal(state.registry[0]?.status, "active");
    assert.equal(state.registry[1]?.status, "pending");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave reconciles bare PROJECT milestone IDs onto existing unique-ID rows (no phantom row) (#807)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    // Planner already minted a unique-ID milestone for sequence 1.
    insertMilestone({ id: "M001-b1nole", title: "Foundation", status: "active" });

    // A faithfully-authored PROJECT.md uses the template's bare sequence IDs.
    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "Deep project setup output.",
        "",
        "## Project Shape",
        "",
        "**Complexity:** complex",
        "**Why:** It spans multiple delivery steps.",
        "",
        "## Capability Contract",
        "",
        "See .gsd/REQUIREMENTS.md.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "- [ ] M002: Polish - Follow-up experience work.",
        "",
      ].join("\n"),
    }, base));

    assert.equal(result.isError, undefined);
    // Bare M001 maps onto the planner's canonical row; M002 is genuinely new.
    assert.deepEqual(result.details.registeredMilestones, ["M001-b1nole", "M002"]);

    const milestones = getAllMilestones();
    // No phantom bare "M001" row — the unique-ID row is preserved and not demoted.
    assert.deepEqual(
      milestones.map((m) => [m.id, m.title, m.status]).sort(),
      [
        ["M001-b1nole", "Foundation", "active"],
        ["M002", "Polish", "queued"],
      ].sort(),
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave fails before persisting PROJECT when milestone registration throws", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const originalPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes("INSERT OR IGNORE INTO milestones")) {
        throw new Error("simulated milestone registration failure");
      }
      return originalPrepare(sql);
    };

    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: [
        "# Project",
        "",
        "## What This Is",
        "",
        "Deep project setup output.",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "",
      ].join("\n"),
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.path, "PROJECT.md");
    assert.equal(result.details.error, "milestone_registration_threw");
    assert.match(String(result.details.registration_error), /simulated milestone registration failure/);
    assert.match(result.content[0].text, /milestone registration failed/);
    assert.match(result.content[0].text, /idempotent/);
    assert.equal(existsSync(join(base, ".gsd", "PROJECT.md")), false);
    const artifact = originalPrepare("SELECT path FROM artifacts WHERE path = ?").get("PROJECT.md");
    assert.equal(artifact, undefined);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave blocks final root artifacts while approval gate is pending", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    setPendingGate("depth_verification_requirements_confirm", base);

    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n",
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "root_artifact_write_blocked");
    assert.equal(
      result.details.displayReason,
      "Approval confirmation required before saving final project setup artifacts.",
    );
    assert.match(result.content[0].text, /has not been confirmed/);
    assert.equal(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), false);

    const draft = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS-DRAFT",
      content: "# Draft Requirements\n",
    }, base));
    assert.equal(draft.isError, undefined);
    assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS-DRAFT.md")));
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave requires verified root approval in deep mode", async () => {
  const base = makeTmpBase();
  try {
    writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
    openTestDb(base);

    const projectFixture = [
      "# Project",
      "",
      "## What This Is",
      "",
      "A root project artifact.",
      "",
      "## Milestone Sequence",
      "",
      "- [ ] M001: Foundation - Establish the first runnable slice.",
      "",
    ].join("\n");

    const blocked = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: projectFixture,
    }, base));

    assert.equal(blocked.isError, true);
    assert.equal(blocked.details.error, "root_artifact_write_blocked");
    assert.equal(
      blocked.details.displayReason,
      "Approval confirmation required before saving final project setup artifacts.",
    );
    assert.match(blocked.content[0].text, /fail-closed/);
    assert.equal(existsSync(join(base, ".gsd", "PROJECT.md")), false);

    markApprovalGateVerified("depth_verification_project_confirm", base);

    const unblocked = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "PROJECT",
      content: projectFixture,
    }, base));

    assert.equal(unblocked.isError, undefined);
    assert.equal(unblocked.details.path, "PROJECT.md");
    assert.ok(existsSync(join(base, ".gsd", "PROJECT.md")));
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave renders final REQUIREMENTS from the DB source of truth", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    markApprovalGateVerified("depth_verification_requirements_confirm", base);

    upsertRequirement({
      id: "R001",
      class: "primary-user-loop",
      status: "active",
      description: "User can add a task",
      why: "Core loop",
      source: "user",
      primary_owner: "M001/none yet",
      supporting_slices: "none",
      validation: "unmapped",
      notes: "saved through requirement tool",
      full_content: "",
      superseded_by: null,
    });

    const requirementsPath = join(base, ".gsd", "REQUIREMENTS.md");
    const bloatedMarkdown = [
      "# Requirements",
      "",
      "## Active",
      "",
      ...Array.from({ length: 30 }, (_, i) => [
        `### R${String(i + 100).padStart(3, "0")} — Duplicate`,
        "- Class: primary-user-loop",
        "- Status: active",
        "- Description: Duplicate retry row",
        "- Why it matters: Retry drift",
        "- Source: test",
        "- Primary owning slice: M001/none yet",
        "- Supporting slices: none",
        "- Validation: unmapped",
        "",
      ].join("\n")),
    ].join("\n");
    writeFileSync(requirementsPath, bloatedMarkdown);

    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n\n### R999 — Wrong markdown source\n\n- Description: This content must not become canonical.\n",
    }, base));

    assert.equal(result.isError, undefined);
    assert.equal(result.details.path, "REQUIREMENTS.md");
    assert.equal(result.details.content_source, "requirements_table");

    const content = readFileSync(requirementsPath, "utf-8");
    assert.match(content, /### R001 — User can add a task/);
    assert.match(content, /## Validated/);
    assert.match(content, /## Deferred/);
    assert.match(content, /## Out of Scope/);
    assert.doesNotMatch(content, /R999|Wrong markdown source|This content must not become canonical/);
    assert.ok(
      Buffer.byteLength(content, "utf-8") < Buffer.byteLength(bloatedMarkdown, "utf-8") * 0.5,
      "test setup proves final DB projection may be much smaller than accumulated retry output",
    );

    const db = _getAdapter();
    const reqRows = db!
      .prepare("SELECT id, description FROM requirements ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      reqRows.map((row) => [row.id, row.description]),
      [["R001", "User can add a task"]],
      "summary save must not parse markdown back into requirements rows",
    );

    const artifact = db!
      .prepare("SELECT full_content FROM artifacts WHERE path = ?")
      .get("REQUIREMENTS.md") as Record<string, unknown>;
    assert.equal(artifact.full_content, content);
  } finally {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave rejects final REQUIREMENTS when the DB source is empty", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "REQUIREMENTS",
      content: "# Requirements\n\n## Active\n\n",
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.error, "no_active_requirements");
    assert.match(result.content[0].text, /no active requirements found/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave rejects milestone-scoped artifacts without milestone_id", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executeSummarySave({
      artifact_type: "CONTEXT",
      content: "# Context\n",
    }, base));
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "missing_milestone_id");
    assert.match(result.content[0].text, /milestone_id is required/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave removes sibling CONTEXT-DRAFT when writing slice CONTEXT (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    const draftPath = join(sliceDir, "S01-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Slice Draft\n\nincremental slice notes");
    assert.ok(existsSync(draftPath), "precondition: slice draft exists");

    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "CONTEXT",
      content: "# Slice Context\n\nfinal slice output",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.artifact_type, "CONTEXT");

    const contextPath = join(sliceDir, "S01-CONTEXT.md");
    assert.ok(existsSync(contextPath), "slice CONTEXT.md should be written");
    assert.equal(
      existsSync(draftPath),
      false,
      "slice CONTEXT-DRAFT.md should be removed after final CONTEXT.md is written",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave leaves sibling CONTEXT-DRAFT intact for non-CONTEXT artifacts (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const draftPath = join(milestoneDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nstill in progress");

    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "RESEARCH",
      content: "# Research\n\nresearch notes",
    }, base));

    assert.equal(result.details.artifact_type, "RESEARCH");
    assert.ok(
      existsSync(draftPath),
      "CONTEXT-DRAFT.md must survive RESEARCH/SUMMARY/ASSESSMENT writes",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave CONTEXT HARD BLOCK clears after write-gate state file is deleted (#4343)", async () => {
  const base = makeTmpBase();
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";
  try {
    openTestDb(base);
    clearDiscussionFlowState(base);

    // First call: CONTEXT artifact without depth verification → HARD BLOCK
    const blocked = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\ncontent",
    }, base));
    assert.equal(blocked.isError, true, "should be blocked without depth verification");
    assert.equal(
      blocked.details.displayReason,
      "Depth check required before writing milestone context.",
    );
    assert.match(
      blocked.content[0].text,
      /HARD BLOCK/,
      "blocked result should mention HARD BLOCK",
    );

    // Verify the state file was written (persist mode is active)
    const stateFilePath = join(base, ".gsd", "runtime", "write-gate-state.json");
    // The state file may or may not exist at this point (block doesn't write state).
    // Write a fake state file simulating stale persisted block state.
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify({
      verifiedDepthMilestones: [],
      activeQueuePhase: false,
      pendingGateId: "depth_verification_M001",
    }));

    // User deletes the state file to reset the block
    unlinkSync(stateFilePath);
    assert.ok(!existsSync(stateFilePath), "state file deleted");

    // The snapshot loaded after deletion should be clean (no pending gate, no block)
    const snapshot = loadWriteGateSnapshot(base);
    assert.equal(snapshot.pendingGateId, null, "pendingGateId should be null after file deletion");
    assert.deepEqual(snapshot.verifiedDepthMilestones, [], "verifiedDepthMilestones should be empty after file deletion");

    // Depth-verify and re-attempt: should succeed after deletion clears stale state
    markDepthVerified("M001", base);

    const unblocked = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\nfinal content",
    }, base));
    assert.equal(unblocked.isError, undefined, "should not be blocked after depth verification");
    assert.equal(unblocked.details.operation, "save_summary");
  } finally {
    if (originalEnv === undefined) {
      delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
    } else {
      process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
    }
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  }
});
