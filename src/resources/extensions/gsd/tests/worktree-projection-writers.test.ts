// Project/App: gsd-pi
// File Purpose: Regression tests for workflow artifact writers in milestone worktrees.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import { clearParseCache } from "../files.ts";
import { clearPathCache } from "../paths.ts";
import { invalidateStateCache } from "../state.ts";
import { handleCompleteSlice as handleCompleteSliceWithInvocation } from "../tools/complete-slice.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { internalExecutionInvocation, type ExecutionInvocation } from "../execution-invocation.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";

const MID = "M001";
const SID = "S01";
let completionCall = 0;

function handleCompleteSlice(
  params: Parameters<typeof handleCompleteSliceWithInvocation>[0],
  basePath: string,
  invocation?: ExecutionInvocation,
): ReturnType<typeof handleCompleteSliceWithInvocation> {
  return handleCompleteSliceWithInvocation(
    params,
    basePath,
    invocation ?? internalExecutionInvocation(`test:worktree-complete-slice:call:${++completionCall}`),
  );
}

interface WorktreeFixture {
  projectRoot: string;
  worktreeRoot: string;
}

function makeFixture(t: test.TestContext): WorktreeFixture {
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-worktree-projection-")));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", MID);

  mkdirSync(join(projectRoot, ".gsd", "milestones", MID, "slices", SID, "tasks"), { recursive: true });
  mkdirSync(join(worktreeRoot, ".gsd", "milestones", MID, "slices", SID, "tasks"), { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), "gitdir: ../../../.git/worktrees/M001\n", "utf8");

  assert.equal(openDatabase(join(projectRoot, ".gsd", "gsd.db")), true);

  t.after(() => {
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
    closeDatabase();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  return { projectRoot, worktreeRoot };
}

function seedMilestoneAndSlice(): void {
  insertMilestone({ id: MID, title: "Milestone" });
  insertSlice({ id: SID, milestoneId: MID, title: "Slice" });
}

function completeTaskParams(taskId = "T01") {
  return {
    taskId,
    sliceId: SID,
    milestoneId: MID,
    oneLiner: "Finished task",
    narrative: "Implemented the task.",
    verification: "node --test passed.",
    deviations: "None.",
    knownIssues: "None.",
    keyFiles: ["app.js"],
    keyDecisions: [],
    blockerDiscovered: false,
    verificationEvidence: [
      {
        command: "node --test",
        exitCode: 0,
        verdict: "pass",
        durationMs: 10,
      },
    ],
  };
}

function completeSliceParams() {
  return {
    sliceId: SID,
    milestoneId: MID,
    sliceTitle: "Slice",
    oneLiner: "Finished slice",
    narrative: "Completed all tasks for the slice.",
    verification: "All task verification passed.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    keyFiles: ["app.js"],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    provides: [],
    requirementsSurfaced: [],
    drillDownPaths: [],
    affects: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [],
    requires: [],
    uatContent: "Run the app and verify the slice behavior.",
  };
}

function validateMilestoneParams() {
  return {
    milestoneId: MID,
    verdict: "pass" as const,
    remediationRound: 0,
    successCriteriaChecklist: "- Passed",
    sliceDeliveryAudit: "- Slices delivered",
    crossSliceIntegration: "- Integrated",
    requirementCoverage: "- Covered",
    verdictRationale: "Milestone meets the acceptance criteria.",
  };
}

test("complete-slice writes SUMMARY and UAT under the active worktree projection", async (t) => {
  const { projectRoot, worktreeRoot } = makeFixture(t);
  seedMilestoneAndSlice();
  insertTask({ id: "T01", sliceId: SID, milestoneId: MID, status: "complete", title: "Task" });
  seedSliceCompletionAuthority({
    milestoneId: MID,
    sliceId: SID,
    completedTaskIds: ["T01"],
  });

  const result = await handleCompleteSlice(completeSliceParams(), worktreeRoot);

  assert.ok(!("error" in result), "complete-slice should succeed");
  const expectedSummary = join(worktreeRoot, ".gsd", "milestones", MID, "slices", SID, "S01-SUMMARY.md");
  const expectedUat = join(worktreeRoot, ".gsd", "milestones", MID, "slices", SID, "S01-UAT.md");
  const projectSummary = join(projectRoot, ".gsd", "milestones", MID, "slices", SID, "S01-SUMMARY.md");
  const projectUat = join(projectRoot, ".gsd", "milestones", MID, "slices", SID, "S01-UAT.md");
  assert.equal(result.summaryPath, expectedSummary);
  assert.equal(result.uatPath, expectedUat);
  assert.equal(existsSync(expectedSummary), true);
  assert.equal(existsSync(expectedUat), true);
  assert.equal(existsSync(projectSummary), false);
  assert.equal(existsSync(projectUat), false);
});

