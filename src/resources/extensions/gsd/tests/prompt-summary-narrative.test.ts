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
  buildExecuteTaskPrompt,
  buildReassessRoadmapPrompt,
  buildValidateMilestonePrompt,
  getPriorTaskSummaries,
  inlineDependencySummaries,
} from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  getScopedArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  setTaskSummaryMd,
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
  assert.equal(
    getScopedArtifact("M001", "S01", null, "SUMMARY") ?? null,
    null,
    "the reopen removes the SUMMARY artifact row",
  );

  for (const [builder, prompt] of Object.entries(await slicePrompts(base))) {
    assert.doesNotMatch(prompt, /FIRST-COMPLETION-MARKER/, `${builder} has no summary of the reopened Slice`);
  }

  // The second completion has no drain: no artifact row holds its text.
  seedSliceCompletionAuthority({ milestoneId: "M001", sliceId: "S01", completedTaskIds: ["T01"], runId: "second" });
  const completedAgain = await completeS01(base, "SECOND-COMPLETION-MARKER");
  assert.ok(!("error" in completedAgain), `unexpected error: ${"error" in completedAgain ? completedAgain.error : ""}`);

  for (const [builder, prompt] of Object.entries(await slicePrompts(base))) {
    assert.match(prompt, /SECOND-COMPLETION-MARKER/, `${builder} has the summary of the second completion`);
    assert.doesNotMatch(prompt, /FIRST-COMPLETION-MARKER/, `${builder} has no summary of the first completion`);
  }
});

test("a reopened Task gives no SUMMARY to the prompts, and its artifact row is removed", async () => {
  const base = makeProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Receipt", status: "pending" });
  // The projection seam of the Task completion: the file and the SUMMARY artifact row.
  assert.equal(await renderTaskSummary(base, "M001", "S01", "T01"), true);

  const priorSummaries = await getPriorTaskSummaries(base, "M001", "S01", "T02");
  assert.equal(priorSummaries.length, 1);
  assert.match(await buildCarryForwardSection(priorSummaries), /TASK-SUMMARY-MARKER/);
  assert.match(await buildCompleteSlicePrompt("M001", "Checkout", "S01", "Foundation", base), /TASK-SUMMARY-MARKER/);

  const reopened = await handleReopenTask(
    { milestoneId: "M001", sliceId: "S01", taskId: "T01", reason: "regression found" },
    base,
    internalExecutionInvocation("test/prompt-summary/reopen-task"),
  );
  assert.ok(!("error" in reopened), `unexpected error: ${"error" in reopened ? reopened.error : ""}`);
  assert.equal(
    getScopedArtifact("M001", "S01", "T01", "SUMMARY") ?? null,
    null,
    "the reopen removes the SUMMARY artifact row",
  );

  invalidateAllCaches();
  const summariesAfterReopen = await getPriorTaskSummaries(base, "M001", "S01", "T02");
  assert.deepEqual(summariesAfterReopen, []);
  assert.doesNotMatch(await buildCarryForwardSection(summariesAfterReopen), /TASK-SUMMARY-MARKER/);
  assert.doesNotMatch(
    await buildCompleteSlicePrompt("M001", "Checkout", "S01", "Foundation", base),
    /TASK-SUMMARY-MARKER/,
  );
});

test("a completed Task gives its SUMMARY to the next prompts when its projection is not rendered", async () => {
  const base = makeProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Receipt", status: "pending" });
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T03", title: "Refund", status: "pending" });
  // The durable pipeline commits the completion; its SUMMARY projection render
  // fails (a directory sits at the file path). The committed row is what the
  // prompts read.
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T02-SUMMARY.md"), { recursive: true });
  setTaskSummaryMd(
    "M001", "S01", "T02",
    "---\nid: T02\n---\n\n# T02: Receipt\n\n**COMMITTED-TASK-MARKER**\n\nThe receipt was built.\n",
  );
  _getAdapter()!.prepare(`
    UPDATE tasks SET status = 'complete', completed_at = :now
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T02'
  `).run({ ":now": new Date().toISOString() });

  invalidateAllCaches();
  assert.deepEqual(
    (await getPriorTaskSummaries(base, "M001", "S01", "T03")).map((summary) => summary.taskId),
    ["T01", "T02"],
  );
  assert.match(
    await buildExecuteTaskPrompt("M001", "S01", "Foundation", "T03", "Refund", base),
    /COMMITTED-TASK-MARKER/,
    "the execute-task prompt of the next Task has the summary",
  );
  assert.match(
    await buildCompleteSlicePrompt("M001", "Checkout", "S01", "Foundation", base),
    /COMMITTED-TASK-MARKER/,
    "the complete-slice prompt has the summary",
  );
});

test("the SUMMARY carrier of a done Task comes before its artifact row", async () => {
  const base = makeProject();
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T02", title: "Receipt", status: "pending" });
  assert.equal(await renderTaskSummary(base, "M001", "S01", "T01"), true);
  // A second completion of T01 that has no drain: the artifact row holds the first text.
  setTaskSummaryMd("M001", "S01", "T01", "---\nid: T01\n---\n\n# T01: Gateway\n\n**SECOND-COMPLETION-MARKER**\n");

  invalidateAllCaches();
  const carryForward = await buildCarryForwardSection(await getPriorTaskSummaries(base, "M001", "S01", "T02"));
  assert.match(carryForward, /SECOND-COMPLETION-MARKER/);
  assert.doesNotMatch(carryForward, /TASK-SUMMARY-MARKER/);
});
