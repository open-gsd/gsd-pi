// Project/App: gsd-pi
// File Purpose: Behavior tests for SUMMARY narrative in prompts. The SUMMARY of
// a Slice or Task follows the database state that the real completion and
// reopen operations write: a completed Slice gives its current summary with
// no projection drain, and a reopened Slice or Task gives none.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  buildCarryForwardSection,
  buildCompleteSlicePrompt,
  buildReassessRoadmapPrompt,
  buildValidateMilestonePrompt,
  getPriorTaskSummaryPaths,
  inlineDependencySummaries,
} from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import {
  closeDatabase,
  getScopedArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { renderTaskSummary } from "../markdown-renderer.ts";
import { flushWorkflowProjections } from "../projection-flush.ts";
import { handleCompleteSlice } from "../tools/complete-slice.ts";
import { handleReopenSlice } from "../tools/reopen-slice.ts";
import { handleReopenTask } from "../tools/reopen-task.ts";
import type { CompleteSliceParams } from "../types.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateAllCaches();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

/** M001 with S01 (its Task T01 is complete) and S02, which depends on S01. */
function makeProject(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-prompt-summary-")));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);

  insertMilestone({ id: "M001", title: "Checkout", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "in_progress", risk: "low", depends: [], sequence: 1 });
  insertSlice({ milestoneId: "M001", id: "S02", title: "Payment", status: "pending", risk: "low", depends: ["S01"], sequence: 2 });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Gateway",
    status: "complete",
    fullSummaryMd: "---\nid: T01\n---\n\n# T01: Gateway\n\n**TASK-SUMMARY-MARKER**\n\n## What Happened\n\nWork was done.\n",
  });
  insertTask({ milestoneId: "M001", sliceId: "S02", id: "T01", title: "Receipt", status: "pending" });
  return base;
}

function completeS01(base: string, marker: string): ReturnType<typeof handleCompleteSlice> {
  const params: CompleteSliceParams = {
    milestoneId: "M001",
    sliceId: "S01",
    sliceTitle: "Foundation",
    oneLiner: marker,
    narrative: "The foundation was built.",
    verification: "The tests pass.",
    uatContent: "## Smoke Test\n\nRun the tests.",
  };
  return handleCompleteSlice(params, base, internalExecutionInvocation(`test/prompt-summary/${marker}`));
}

/** The prompts that inline the SUMMARY of S01. */
async function slicePrompts(base: string): Promise<Record<string, string>> {
  invalidateAllCaches();
  return {
    reassessRoadmap: await buildReassessRoadmapPrompt("M001", "Checkout", "S01", base),
    dependencySummaries: await inlineDependencySummaries("M001", "S02", base),
    validateMilestone: await buildValidateMilestonePrompt("M001", "Checkout", base),
  };
}

test("a completed Slice gives its SUMMARY to the next prompts before any projection drain", async () => {
  const base = makeProject();
  seedSliceCompletionAuthority({ milestoneId: "M001", sliceId: "S01", completedTaskIds: ["T01"] });

  const result = await completeS01(base, "FIRST-COMPLETION-MARKER");
  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);

  for (const [builder, prompt] of Object.entries(await slicePrompts(base))) {
    assert.match(prompt, /FIRST-COMPLETION-MARKER/, `${builder} has the summary of the completed Slice`);
  }
});

test("a reopened Slice gives no SUMMARY to the prompts, and a second completion gives its own", async () => {
  const base = makeProject();
  seedSliceCompletionAuthority({ milestoneId: "M001", sliceId: "S01", completedTaskIds: ["T01"] });
  const completed = await completeS01(base, "FIRST-COMPLETION-MARKER");
  assert.ok(!("error" in completed), `unexpected error: ${"error" in completed ? completed.error : ""}`);
  // A later tool drains Projection Work: this writes the SUMMARY artifact row.
  await flushWorkflowProjections(base, { milestoneId: "M001" });

  const reopened = await handleReopenSlice(
    { milestoneId: "M001", sliceId: "S01", reason: "redo" },
    base,
    internalExecutionInvocation("test/prompt-summary/reopen-slice"),
  );
  assert.ok(!("error" in reopened), `unexpected error: ${"error" in reopened ? reopened.error : ""}`);
  assert.match(
    getScopedArtifact("M001", "S01", null, "SUMMARY")?.full_content ?? "",
    /FIRST-COMPLETION-MARKER/,
    "the reopen keeps the SUMMARY artifact row",
  );

  for (const [builder, prompt] of Object.entries(await slicePrompts(base))) {
    assert.doesNotMatch(prompt, /FIRST-COMPLETION-MARKER/, `${builder} has no summary of the reopened Slice`);
  }

  // The second completion has no drain: the artifact row still holds the first text.
  seedSliceCompletionAuthority({ milestoneId: "M001", sliceId: "S01", completedTaskIds: ["T01"], runId: "second" });
  const completedAgain = await completeS01(base, "SECOND-COMPLETION-MARKER");
  assert.ok(!("error" in completedAgain), `unexpected error: ${"error" in completedAgain ? completedAgain.error : ""}`);

  for (const [builder, prompt] of Object.entries(await slicePrompts(base))) {
    assert.match(prompt, /SECOND-COMPLETION-MARKER/, `${builder} has the summary of the second completion`);
    assert.doesNotMatch(prompt, /FIRST-COMPLETION-MARKER/, `${builder} has no summary of the first completion`);
  }
});

test("a reopened Task gives no SUMMARY to the prompts, although its artifact row stays", async () => {
  const base = makeProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Receipt", status: "pending" });
  // The projection seam of the Task completion: the file and the SUMMARY artifact row.
  assert.equal(await renderTaskSummary(base, "M001", "S01", "T01"), true);

  const priorPaths = await getPriorTaskSummaryPaths("M001", "S01", "T02");
  assert.equal(priorPaths.length, 1);
  assert.match(await buildCarryForwardSection(priorPaths), /TASK-SUMMARY-MARKER/);
  assert.match(await buildCompleteSlicePrompt("M001", "Checkout", "S01", "Foundation", base), /TASK-SUMMARY-MARKER/);

  const reopened = await handleReopenTask(
    { milestoneId: "M001", sliceId: "S01", taskId: "T01", reason: "regression found" },
    base,
    internalExecutionInvocation("test/prompt-summary/reopen-task"),
  );
  assert.ok(!("error" in reopened), `unexpected error: ${"error" in reopened ? reopened.error : ""}`);
  assert.match(
    getScopedArtifact("M001", "S01", "T01", "SUMMARY")?.full_content ?? "",
    /TASK-SUMMARY-MARKER/,
    "the reopen keeps the SUMMARY artifact row",
  );

  invalidateAllCaches();
  const pathsAfterReopen = await getPriorTaskSummaryPaths("M001", "S01", "T02");
  assert.deepEqual(pathsAfterReopen, []);
  assert.doesNotMatch(await buildCarryForwardSection(pathsAfterReopen), /TASK-SUMMARY-MARKER/);
  assert.doesNotMatch(
    await buildCompleteSlicePrompt("M001", "Checkout", "S01", "Foundation", base),
    /TASK-SUMMARY-MARKER/,
  );
});
