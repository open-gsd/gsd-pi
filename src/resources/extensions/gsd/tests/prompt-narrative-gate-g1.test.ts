// Project/App: gsd-pi
// File Purpose: Gate G1 behavior tests for prompt narrative. Prompt builders
// take ROADMAP, CONTEXT, RESEARCH, PLAN and SUMMARY text from artifact rows:
// a prompt is the same when the projection files are deleted or changed.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  buildCompleteMilestonePrompt,
  buildCompleteSlicePrompt,
  buildDiscussMilestoneInlinedContext,
  buildExecuteTaskPrompt,
  buildPlanMilestonePrompt,
  buildPlanSlicePrompt,
  buildReassessRoadmapPrompt,
  buildReplanSlicePrompt,
  buildResearchMilestonePrompt,
  buildResearchSlicePrompt,
  buildValidateMilestonePrompt,
} from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import { closeDatabase, insertArtifact, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { buildDiscussSlicePrompt } from "../guided-flow.ts";
import { buildExistingMilestonesContext } from "../guided-flow-queue.ts";
import { deriveState } from "../state.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateAllCaches();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function summary(id: string, marker: string, blocker = false): string {
  return [
    "---",
    `id: ${id}`,
    "provides:",
    `  - ${marker}-PROVIDES`,
    `blocker_discovered: ${blocker}`,
    "---",
    "",
    `# ${id}: ${marker}`,
    `**${marker}-ONE-LINER**`,
    "",
    "## What Happened",
    "",
    "Work was done.",
    "",
  ].join("\n");
}

/** Every narrative artifact of the fixture project, keyed by its projection path. */
const NARRATIVE: ReadonlyArray<{
  path: string;
  type: string;
  milestone: string;
  slice?: string;
  task?: string;
  content: string;
}> = [
  { path: "milestones/M001/M001-SUMMARY.md", type: "SUMMARY", milestone: "M001", content: "# M001 Summary\n\nG1-M001-SUMMARY\n" },
  {
    path: "milestones/M002/M002-ROADMAP.md",
    type: "ROADMAP",
    milestone: "M002",
    content: [
      "# M002: Checkout",
      "",
      "G1-M002-ROADMAP",
      "",
      "## Slices",
      "",
      "- [x] **S01: Foundation** `risk:low` `depends:[]`",
      "- [ ] **S02: Payment** `risk:medium` `depends:[S01]`",
      "",
    ].join("\n"),
  },
  { path: "milestones/M002/M002-CONTEXT.md", type: "CONTEXT", milestone: "M002", content: "# M002 Context\n\nG1-M002-CONTEXT\n" },
  { path: "milestones/M002/M002-RESEARCH.md", type: "RESEARCH", milestone: "M002", content: "# M002 Research\n\nG1-M002-RESEARCH\n" },
  { path: "milestones/M002/slices/S01/S01-SUMMARY.md", type: "SUMMARY", milestone: "M002", slice: "S01", content: summary("S01", "G1-S01-SUMMARY") },
  { path: "milestones/M002/slices/S02/S02-CONTEXT.md", type: "CONTEXT", milestone: "M002", slice: "S02", content: "# S02 Context\n\nG1-S02-CONTEXT\n" },
  { path: "milestones/M002/slices/S02/S02-RESEARCH.md", type: "RESEARCH", milestone: "M002", slice: "S02", content: "# S02 Research\n\nG1-S02-RESEARCH\n" },
  {
    path: "milestones/M002/slices/S02/S02-PLAN.md",
    type: "PLAN",
    milestone: "M002",
    slice: "S02",
    content: [
      "# S02: Payment",
      "",
      "**Goal:** G1-S02-PLAN",
      "**Demo:** A payment is taken.",
      "",
      "## Tasks",
      "",
      "- [x] **T01: Gateway** `est:1h`",
      "- [ ] **T02: Receipt** `est:1h`",
      "",
      "## Verification",
      "",
      "- The payment test passes.",
      "",
    ].join("\n"),
  },
  { path: "milestones/M002/slices/S02/tasks/T01-SUMMARY.md", type: "SUMMARY", milestone: "M002", slice: "S02", task: "T01", content: summary("T01", "G1-T01-SUMMARY", true) },
  { path: "milestones/M002/slices/S02/tasks/T02-PLAN.md", type: "PLAN", milestone: "M002", slice: "S02", task: "T02", content: "# T02: Receipt\n\nG1-T02-PLAN\n\n## Steps\n\n1. Send the receipt.\n" },
];

const MARKERS = [
  "G1-M001-SUMMARY",
  "G1-M002-ROADMAP",
  "G1-M002-CONTEXT",
  "G1-M002-RESEARCH",
  "G1-S01-SUMMARY",
  "G1-S02-CONTEXT",
  "G1-S02-RESEARCH",
  "G1-S02-PLAN",
  "G1-T01-SUMMARY",
  "G1-T02-PLAN",
];

/**
 * A project whose narrative is saved in artifact rows, with a projection file
 * for each row that holds the same bytes (the contract of the renderer).
 */
function makeProject(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-prompt-gate-g1-")));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);

  insertMilestone({ id: "M001", title: "Catalog", status: "complete" });
  insertMilestone({ id: "M002", title: "Checkout", status: "active" });
  insertSlice({ milestoneId: "M002", id: "S01", title: "Foundation", status: "complete", risk: "low", depends: [], sequence: 1 });
  insertSlice({ milestoneId: "M002", id: "S02", title: "Payment", status: "in_progress", risk: "medium", depends: ["S01"], sequence: 2 });
  insertTask({ milestoneId: "M002", sliceId: "S02", id: "T01", title: "Gateway", status: "complete" });
  insertTask({ milestoneId: "M002", sliceId: "S02", id: "T02", title: "Receipt", status: "pending" });

  for (const artifact of NARRATIVE) {
    insertArtifact({
      path: artifact.path,
      artifact_type: artifact.type,
      milestone_id: artifact.milestone,
      slice_id: artifact.slice ?? null,
      task_id: artifact.task ?? null,
      full_content: artifact.content,
    });
    const file = join(base, ".gsd", artifact.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, artifact.content, "utf-8");
  }
  return base;
}

/** The projection files of the fixture project. Directories are not listed. */
function projectionFiles(base: string): string[] {
  const root = join(base, ".gsd", "milestones");
  return readdirSync(root, { recursive: true, encoding: "utf-8" })
    .map((entry) => join(root, entry))
    .filter((path) => statSync(path).isFile());
}

/** Every prompt that inlines hierarchy narrative, keyed by its builder. */
async function buildPrompts(base: string): Promise<Record<string, string>> {
  invalidateAllCaches();
  const state = await deriveState(base);
  return {
    // The full discuss-milestone prompt has a random opener line; this is its narrative part.
    discussMilestone: await buildDiscussMilestoneInlinedContext("M002", base),
    researchMilestone: await buildResearchMilestonePrompt("M002", "Checkout", base),
    planMilestone: await buildPlanMilestonePrompt("M002", "Checkout", base, scopeMilestone(createWorkspace(base), "M002")),
    researchSlice: await buildResearchSlicePrompt("M002", "Checkout", "S02", "Payment", base),
    planSlice: await buildPlanSlicePrompt("M002", "Checkout", "S02", "Payment", base),
    executeTask: await buildExecuteTaskPrompt("M002", "S02", "Payment", "T02", "Receipt", base),
    completeSlice: await buildCompleteSlicePrompt("M002", "Checkout", "S02", "Payment", base),
    replanSlice: await buildReplanSlicePrompt("M002", "Checkout", "S02", "Payment", base),
    reassessRoadmap: await buildReassessRoadmapPrompt("M002", "Checkout", "S01", base),
    completeMilestone: await buildCompleteMilestonePrompt("M002", "Checkout", base),
    validateMilestone: await buildValidateMilestonePrompt("M002", "Checkout", base),
    discussSlice: await buildDiscussSlicePrompt("M002", "S02", "Payment", base),
    queueContext: await buildExistingMilestonesContext(base, ["M001", "M002"], state),
  };
}

function assertSamePrompts(actual: Record<string, string>, expected: Record<string, string>): void {
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const builder of Object.keys(expected)) {
    assert.equal(actual[builder], expected[builder], `${builder} prompt`);
  }
}

test("Gate G1: every prompt is the same when the projection files are deleted", async () => {
  const base = makeProject();
  const before = await buildPrompts(base);

  // The fixture is not vacuous: every narrative artifact reaches a prompt.
  const allPrompts = Object.values(before).join("\n");
  for (const marker of MARKERS) {
    assert.ok(allPrompts.includes(marker), `${marker} must be in a prompt before the files are deleted`);
  }

  const files = projectionFiles(base);
  assert.equal(files.length, NARRATIVE.length);
  for (const file of files) rmSync(file);
  assert.deepEqual(projectionFiles(base), []);

  assertSamePrompts(await buildPrompts(base), before);
});

test("Gate G1: every prompt follows the artifact rows when the projection files disagree", async () => {
  const base = makeProject();
  const before = await buildPrompts(base);

  for (const file of projectionFiles(base)) {
    writeFileSync(file, "---\nid: POISON\nblocker_discovered: true\n---\n# POISONED-PROJECTION-FILE\n\n**Goal:** POISONED-PROJECTION-FILE\n", "utf-8");
  }

  const after = await buildPrompts(base);
  assertSamePrompts(after, before);
  assert.ok(!Object.values(after).join("\n").includes("POISONED-PROJECTION-FILE"));
});

test("Gate G1: a projection file with no artifact row is not narrative", async () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-prompt-gate-g1-norow-")));
  tempDirectories.add(base);
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Catalog", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "in_progress", risk: "low", depends: [], sequence: 1 });
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Schema", status: "pending" });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n\nFILE-ONLY-CONTEXT\n", "utf-8");
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01\n\n**Goal:** FILE-ONLY-SLICE-PLAN\n", "utf-8");
  writeFileSync(join(sliceDir, "tasks", "T01-PLAN.md"), "# T01\n\nFILE-ONLY-TASK-PLAN\n", "utf-8");

  const research = await buildResearchMilestonePrompt("M001", "Catalog", base);
  assert.ok(!research.includes("FILE-ONLY-CONTEXT"));
  assert.match(research, /### Milestone Context\nSource: `\.gsd\/milestones\/M001\/M001-CONTEXT\.md`\n\n_\(not found/);

  const execute = await buildExecuteTaskPrompt("M001", "S01", "Foundation", "T01", "Schema", base);
  assert.ok(!execute.includes("FILE-ONLY-TASK-PLAN"));
  assert.ok(!execute.includes("FILE-ONLY-SLICE-PLAN"));
  assert.match(execute, /Task plan not found at dispatch time/);

  // With a saved row the prompt takes the row text, not the file text.
  insertArtifact({
    path: "milestones/M001/slices/S01/tasks/T01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# T01\n\nROW-TASK-PLAN\n",
  });
  const executeWithRow = await buildExecuteTaskPrompt("M001", "S01", "Foundation", "T01", "Schema", base);
  assert.ok(executeWithRow.includes("ROW-TASK-PLAN"));
  assert.ok(!executeWithRow.includes("FILE-ONLY-TASK-PLAN"));
});
