// Project/App: gsd-pi
// File Purpose: Behavior tests for the read cutover of the drift checks, the
// doctor checks, the discard operation, the parallel merge and the
// prompt-content decision sites. On a Project whose Authority Epoch has
// advanced they follow the canonical lifecycle rows when legacy rows disagree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { buildCompleteMilestonePrompt, buildRewriteDocsPrompt, buildValidateMilestonePrompt } from "../auto-prompts.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import { checkGsdStateHealth } from "../doctor-state-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import {
  _getAdapter,
  closeDatabase,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { buildDiscussSlicePrompt } from "../guided-flow.ts";
import { discardMilestone } from "../milestone-actions.ts";
import { recordLegacyMilestoneEvents } from "../milestone-reopen-events.ts";
import { isMilestoneCompleteInProjectDb } from "../parallel-merge.ts";
import { handleRethink } from "../rethink.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { detectArtifactDbDrift } from "../state-reconciliation/drift/artifact-db.ts";
import { cutOver, seedLifecycles, type Lifecycle } from "./helpers/authority-cutover.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function makeProject(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-lifecycle-read-cutover-decision-sites-")));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function milestone(milestoneId: string, lifecycleStatus: Lifecycle["lifecycleStatus"]): Lifecycle {
  return { itemKind: "milestone", milestoneId, lifecycleStatus };
}

function slice(milestoneId: string, sliceId: string, lifecycleStatus: Lifecycle["lifecycleStatus"]): Lifecycle {
  return { itemKind: "slice", milestoneId, sliceId, lifecycleStatus };
}

function task(
  milestoneId: string,
  sliceId: string,
  taskId: string,
  lifecycleStatus: Lifecycle["lifecycleStatus"],
): Lifecycle {
  return { itemKind: "task", milestoneId, sliceId, taskId, lifecycleStatus };
}

/** Write a projection file under `.gsd/` and its artifact row. */
function writeArtifact(
  base: string,
  path: string,
  scope: { milestoneId: string; sliceId?: string; taskId?: string },
): void {
  const file = join(base, ".gsd", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${path}\n`);
  if (!path.endsWith("-SUMMARY.md")) return;
  insertArtifact({
    path,
    artifact_type: "SUMMARY",
    milestone_id: scope.milestoneId,
    slice_id: scope.sliceId ?? null,
    task_id: scope.taskId ?? null,
    full_content: `# ${path}\n`,
  });
}

/** A completed `complete-milestone` dispatch and the completion event that covers it. */
function seedCompletedCloseout(milestoneId: string): void {
  const adapter = _getAdapter();
  assert.ok(adapter);
  adapter.prepare(`
    INSERT OR REPLACE INTO workers
      (worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath)
    VALUES ('w-cutover-checks', 'local', 1, '2026-09-17T07:53:00.000Z', 'test', '2026-09-17T07:54:00.000Z', 'stopped', '')
  `).run();
  adapter.prepare(`
    INSERT INTO unit_dispatches
      (trace_id, worker_id, milestone_lease_token, milestone_id, unit_type, unit_id, status, attempt_n, started_at, ended_at)
    VALUES
      (:trace_id, 'w-cutover-checks', 1, :milestone_id, 'complete-milestone', :milestone_id, 'completed', 1,
       '2026-09-17T07:53:00.000Z', '2026-09-17T07:54:00.000Z')
  `).run({ ":trace_id": `trace-${milestoneId}`, ":milestone_id": milestoneId });
  recordLegacyMilestoneEvents(
    [{ kind: "completed", milestoneId, occurredAt: "2026-09-17T07:53:30.000Z" }],
    "agent",
  );
}

/**
 * Legacy rows and lifecycle rows that disagree in both directions, with the
 * files of finished work on disk:
 * M001 is legacy active and canonical completed, and so are its Slice S01 and
 * Task T01 (legacy pending). M002 is legacy complete and canonical ready, and
 * so are its Slice S01 and Task T01. Task T02 of M002/S01 is legacy pending
 * and canonical completed. Slice S02 of M002 is legacy complete and canonical
 * in_progress and has no tasks directory. M003 is legacy active and canonical
 * cancelled; its SUMMARY row has no file.
 * S01 and its Tasks have a SUMMARY file and row in both Milestones. Both
 * Milestones have a completed closeout dispatch with a completion event.
 */
function seedCheckDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Canonical completed", status: "active" });
  insertMilestone({ id: "M002", title: "Canonical open", status: "complete" });
  insertMilestone({ id: "M003", title: "Canonical cancelled", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Canonical completed", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Canonical open", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Canonical in progress", status: "complete", depends: [], sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Canonical completed", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M002", title: "Canonical open", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M002", title: "Canonical completed", status: "pending" });
  seedLifecycles("check-disagreement", [
    milestone("M001", "completed"),
    milestone("M002", "ready"),
    milestone("M003", "cancelled"),
    slice("M001", "S01", "completed"),
    slice("M002", "S01", "ready"),
    slice("M002", "S02", "in_progress"),
    task("M001", "S01", "T01", "completed"),
    task("M002", "S01", "T01", "ready"),
    task("M002", "S01", "T02", "completed"),
  ]);
  for (const milestoneId of ["M001", "M002"]) {
    const sliceDirectory = `milestones/${milestoneId}/slices/S01`;
    writeArtifact(base, `milestones/${milestoneId}/${milestoneId}-ROADMAP.md`, { milestoneId });
    writeArtifact(base, `${sliceDirectory}/S01-SUMMARY.md`, { milestoneId, sliceId: "S01" });
    writeArtifact(base, `${sliceDirectory}/tasks/T01-SUMMARY.md`, { milestoneId, sliceId: "S01", taskId: "T01" });
    seedCompletedCloseout(milestoneId);
  }
  writeArtifact(base, "milestones/M001/slices/S01/S01-REPLAN.md", { milestoneId: "M001", sliceId: "S01" });
  writeArtifact(base, "milestones/M002/slices/S01/tasks/T02-SUMMARY.md", { milestoneId: "M002", sliceId: "S01", taskId: "T02" });
  insertArtifact({
    path: "milestones/M003/M003-SUMMARY.md",
    artifact_type: "SUMMARY",
    milestone_id: "M003",
    slice_id: null,
    task_id: null,
    full_content: "# M003\n",
  });
  invalidateStateCache();
  return base;
}

function unitIds(records: ReadonlyArray<{ milestoneId: string; sliceId?: string; taskId?: string }>): string[] {
  return [...new Set(records.map((record) =>
    [record.milestoneId, record.sliceId, record.taskId].filter(Boolean).join("/")))].sort();
}

test("after the Cutover the artifact drift checks take closed milestones, slices and tasks from the lifecycle rows", async () => {
  const base = seedCheckDisagreement();
  const drifts = async () => {
    const state = await deriveState(base);
    const records = detectArtifactDbDrift(state, { basePath: base, state });
    return {
      summaryOfOpenWork: unitIds(records.filter((record) => record.kind === "artifact-db-status-divergence")),
      reopenedAfterCloseout: unitIds(records.filter((record) => record.kind === "completed-milestone-reopened")),
    };
  };

  // The legacy rows: M001, its Slice and its Task are open. M002 is complete.
  assert.deepEqual(await drifts(), {
    summaryOfOpenWork: ["M001/S01", "M001/S01/T01"],
    reopenedAfterCloseout: ["M001"],
  });

  cutOver();

  // The lifecycle rows: M001 is completed. M002, its Slice S01 and its Task
  // T01 are open; its Task T02 is completed.
  assert.deepEqual(await drifts(), {
    summaryOfOpenWork: ["M002/S01", "M002/S01/T01"],
    reopenedAfterCloseout: ["M002"],
  });
});

test("after the Cutover the doctor engine checks take closed and discarded items from the lifecycle rows", async () => {
  const base = seedCheckDisagreement();
  const reported = async () => {
    const issues: DoctorIssue[] = [];
    await checkEngineHealth(base, issues, []);
    const units = (code: DoctorIssue["code"]) =>
      issues.filter((issue) => issue.code === code).map((issue) => issue.unitId).sort();
    return {
      summaryOfOpenWork: units("artifact_db_status_divergence"),
      reopenedAfterCloseout: units("completed_milestone_reopened"),
      missingFile: units("artifact_file_missing"),
    };
  };

  // The legacy rows: M001 is open, M002 is complete, M003 is not discarded.
  assert.deepEqual(await reported(), {
    summaryOfOpenWork: ["M001/S01", "M001/S01/T01"],
    reopenedAfterCloseout: ["M001"],
    missingFile: ["M003"],
  });

  cutOver();

  // The lifecycle rows: M001 is completed, M002 is open, M003 is discarded,
  // so the missing file of its SUMMARY row is not reported.
  assert.deepEqual(await reported(), {
    summaryOfOpenWork: ["M002/S01", "M002/S01/T01"],
    reopenedAfterCloseout: ["M002"],
    missingFile: [],
  });
});

test("after the Cutover the doctor state checks take done slices and tasks from the lifecycle rows", async () => {
  const base = seedCheckDisagreement();
  const reported = async () => {
    const issues: DoctorIssue[] = [];
    await checkGsdStateHealth(base, issues, [], { fix: false, shouldFix: () => false });
    return issues
      .filter((issue) => issue.code === "missing_tasks_dir" || issue.code === "stale_replan_file")
      .map((issue) => [issue.code, issue.unitId, issue.severity]);
  };

  // The legacy rows: Slice M002/S02 is complete, so its missing tasks
  // directory is cosmetic. Task T01 of M001/S01 is pending, so the REPLAN file
  // is not stale.
  assert.deepEqual(await reported(), [["missing_tasks_dir", "M002/S02", "warning"]]);

  cutOver();

  // The lifecycle rows: every Task of M001/S01 is completed, and Slice
  // M002/S02 is in progress.
  assert.deepEqual(await reported(), [
    ["stale_replan_file", "M001/S01", "info"],
    ["missing_tasks_dir", "M002/S02", "error"],
  ]);
});

function lifecycleStatuses(milestoneId: string): Record<string, unknown> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  const rows = adapter.prepare(`
    SELECT slice_id, task_id, lifecycle_status
    FROM workflow_item_lifecycles
    WHERE milestone_id = :milestone_id
  `).all({ ":milestone_id": milestoneId });
  return Object.fromEntries(rows.map((row) => [
    [row["slice_id"], row["task_id"]].filter((id) => id != null).join("/") || "milestone",
    row["lifecycle_status"],
  ]));
}

/**
 * An open Milestone whose rows disagree. Slice S01 and its Task T01 are legacy
 * complete and canonical ready. Slice S02 and Task T02 of S01 are legacy
 * pending and canonical completed.
 */
function seedDiscardDisagreement(milestoneId: string): void {
  insertMilestone({ id: milestoneId, title: "Open", status: "active" });
  insertSlice({ id: "S01", milestoneId, title: "Canonical open", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId, title: "Canonical completed", status: "pending", depends: [], sequence: 2 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId, title: "Canonical open", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId, title: "Canonical completed", status: "pending" });
  seedLifecycles(`discard-${milestoneId.toLowerCase()}`, [
    milestone(milestoneId, "ready"),
    slice(milestoneId, "S01", "ready"),
    slice(milestoneId, "S02", "completed"),
    task(milestoneId, "S01", "T01", "ready"),
    task(milestoneId, "S01", "T02", "completed"),
  ]);
}

test("after the Cutover discard keeps the work that the lifecycle rows close and cancels the rest", async () => {
  const base = makeProject();
  seedDiscardDisagreement("M001");
  seedDiscardDisagreement("M002");

  // Before the Cutover the legacy rows decide: the discard cancels the
  // legacy pending S02 and T02. Their lifecycle rows are completed, so the
  // lifecycle refuses the transition and the operation writes nothing.
  await assert.rejects(discardMilestone(base, "M001"), /invalid workflow lifecycle transition/);
  assert.deepEqual(lifecycleStatuses("M001"), {
    milestone: "ready",
    S01: "ready",
    "S01/T01": "ready",
    "S01/T02": "completed",
    S02: "completed",
  });

  cutOver();

  // After the Cutover the lifecycle rows decide: the completed S02 and T02
  // stay completed, and the open S01 and T01 are cancelled.
  assert.equal(await discardMilestone(base, "M002"), true);
  assert.deepEqual(lifecycleStatuses("M002"), {
    milestone: "cancelled",
    S01: "cancelled",
    "S01/T01": "cancelled",
    "S01/T02": "completed",
    S02: "completed",
  });
});

test("after the Cutover the parallel merge takes the complete milestone from the lifecycle rows of the project database", () => {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Canonical completed", status: "active" });
  insertMilestone({ id: "M002", title: "Canonical open", status: "complete" });
  seedLifecycles("parallel-merge", [milestone("M001", "completed"), milestone("M002", "ready")]);
  const complete = () => ["M001", "M002"].filter((milestoneId) => isMilestoneCompleteInProjectDb(base, milestoneId));

  assert.deepEqual(complete(), ["M002"]);

  cutOver();

  assert.deepEqual(complete(), ["M001"]);
});

// ─── Prompt-content decision sites ───────────────────────────────────────────

/**
 * One active Milestone whose Slices disagree in both directions, each with a
 * saved SUMMARY row and file: S01 is legacy pending and canonical cancelled
 * (only the lifecycle row skips it), S02 is legacy skipped and canonical
 * in_progress (only the legacy row skips it), S03 is legacy pending and
 * canonical completed (only the lifecycle row completes it), S04 is legacy
 * complete and canonical in_progress (only the legacy row completes it), and
 * S05 is the Slice under discussion.
 */
function seedPromptDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Prompt slices", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Canonical cancelled", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Canonical open", status: "skipped", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Canonical completed", status: "pending", depends: [], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Canonical open", status: "complete", depends: [], sequence: 4 });
  insertSlice({ id: "S05", milestoneId: "M001", title: "Under discussion", status: "active", depends: [], sequence: 5 });
  seedLifecycles("prompt-slices", [
    milestone("M001", "ready"),
    slice("M001", "S01", "cancelled"),
    slice("M001", "S02", "in_progress"),
    slice("M001", "S03", "completed"),
    slice("M001", "S04", "in_progress"),
    slice("M001", "S05", "in_progress"),
  ]);
  for (const sid of ["S01", "S02", "S03", "S04"]) {
    const path = `milestones/M001/slices/${sid}/${sid}-SUMMARY.md`;
    const file = join(base, ".gsd", path);
    const content = [
      "---",
      `id: ${sid}`,
      "parent: M001",
      "milestone: M001",
      "---",
      "",
      `# ${sid}`,
      "",
      `SUMMARY-OF-${sid}`,
      "",
    ].join("\n");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    insertArtifact({
      path,
      artifact_type: "SUMMARY",
      milestone_id: "M001",
      slice_id: sid,
      task_id: null,
      full_content: content,
    });
  }
  invalidateStateCache();
  return base;
}

test("after the Cutover the complete-milestone and validate-milestone prompts take their slice summaries from the lifecycle rows", async () => {
  const base = seedPromptDisagreement();
  const summarized = async (build: () => Promise<string>) => {
    const prompt = await build();
    return ["S01", "S02", "S03", "S04", "S05"].filter((sid) => prompt.includes(`### ${sid} Summary (excerpt)`));
  };

  // The legacy rows: every Slice but the skipped S02 is listed.
  assert.deepEqual(
    await summarized(() => buildCompleteMilestonePrompt("M001", "Prompt slices", base)),
    ["S01", "S03", "S04", "S05"],
  );
  assert.deepEqual(
    await summarized(() => buildValidateMilestonePrompt("M001", "Prompt slices", base)),
    ["S01", "S03", "S04", "S05"],
  );

  cutOver();

  // The lifecycle rows: the cancelled S01 is not listed, and the S02 that
  // only the legacy row skips is.
  assert.deepEqual(
    await summarized(() => buildCompleteMilestonePrompt("M001", "Prompt slices", base)),
    ["S02", "S03", "S04", "S05"],
  );
  assert.deepEqual(
    await summarized(() => buildValidateMilestonePrompt("M001", "Prompt slices", base)),
    ["S02", "S03", "S04", "S05"],
  );
});

test("after the Cutover the slice-discussion prompt inlines the summaries of the Slices that the lifecycle rows complete", async () => {
  const base = seedPromptDisagreement();
  const completed = async () => {
    const prompt = await buildDiscussSlicePrompt("M001", "S05", "Under discussion", base);
    return ["S01", "S02", "S03", "S04"].filter((sid) => prompt.includes(`### ${sid} Summary (completed)`));
  };

  // The legacy rows: only the complete S04 is inlined.
  assert.deepEqual(await completed(), ["S04"]);

  cutOver();

  // The lifecycle rows: the completed S03 is inlined; S02 and S04 are open.
  assert.deepEqual(await completed(), ["S03"]);
});

/**
 * An open Milestone whose Task rows disagree: T01 is legacy complete and
 * canonical ready, T02 is legacy pending and canonical completed. The Slice
 * plan and the Task plans are on disk.
 */
function seedTaskDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Open tasks", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Open", status: "active", depends: [], sequence: 1 });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Canonical open", status: "complete" });
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Canonical completed", status: "pending" });
  seedLifecycles("rewrite-docs", [
    milestone("M001", "ready"),
    slice("M001", "S01", "in_progress"),
    task("M001", "S01", "T01", "ready"),
    task("M001", "S01", "T02", "completed"),
  ]);
  const sliceDirectory = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDirectory, "tasks"), { recursive: true });
  writeFileSync(join(sliceDirectory, "S01-PLAN.md"), "# S01\n");
  writeFileSync(join(sliceDirectory, "tasks", "T01-PLAN.md"), "# T01\n");
  writeFileSync(join(sliceDirectory, "tasks", "T02-PLAN.md"), "# T02\n");
  invalidateStateCache();
  return base;
}

test("after the Cutover the rewrite-docs prompt lists the open Tasks of the lifecycle rows", async () => {
  const base = seedTaskDisagreement();
  const listed = async () => {
    const prompt = await buildRewriteDocsPrompt("M001", "Open tasks", { id: "S01", title: "S01" }, base, []);
    return {
      canonicalOpen: /T01-PLAN\.md/.test(prompt),
      legacyOpen: /T02-PLAN\.md/.test(prompt),
    };
  };

  // The legacy rows: T01 is complete, T02 is open.
  assert.deepEqual(await listed(), { canonicalOpen: false, legacyOpen: true });

  cutOver();

  // The lifecycle rows: T01 is ready and T02 is completed.
  assert.deepEqual(await listed(), { canonicalOpen: true, legacyOpen: false });
});

/** A command context that records its notifications, and a session that records the prompts it gets. */
function rethinkSession() {
  const notifications: string[] = [];
  const prompts: string[] = [];
  const ctx = {
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: () => {},
    },
  } as never;
  const pi = {
    sendMessage: (message: { content: string }) => { prompts.push(message.content); },
  } as never;
  return { ctx, pi, notifications, prompts };
}

/**
 * An open Milestone whose Slice rows disagree: S01 is legacy complete and
 * canonical in_progress, S02 is legacy pending and canonical completed, S03
 * is legacy pending and canonical cancelled.
 */
function seedRethinkDisagreement(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Rethink slices", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Canonical open", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Canonical completed", status: "pending", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Canonical cancelled", status: "pending", depends: [], sequence: 3 });
  seedLifecycles("rethink-counts", [
    milestone("M001", "ready"),
    slice("M001", "S01", "in_progress"),
    slice("M001", "S02", "completed"),
    slice("M001", "S03", "cancelled"),
  ]);
  invalidateStateCache();
  return base;
}

test("after the Cutover the rethink prompt takes its Slice counts from the lifecycle rows", async (t) => {
  const base = seedRethinkDisagreement();
  const previousCwd = process.cwd();
  t.after(() => process.chdir(previousCwd));
  process.chdir(base);
  const sliceCell = async () => {
    const { ctx, pi, prompts } = rethinkSession();
    await handleRethink("", ctx, pi);
    assert.equal(prompts.length, 1);
    const row = prompts[0]!.split("\n").find((line) => line.startsWith("| 1 | M001 |"));
    assert.ok(row, `the rethink prompt lists M001:\n${prompts[0]}`);
    return row!.split("|")[6]!.trim();
  };

  // The legacy rows: S01 is complete, S02 and S03 are pending.
  assert.equal(await sliceCell(), "1/3 complete");

  cutOver();

  // The lifecycle rows: S02 is completed and S03 is cancelled; S01 is open.
  assert.equal(await sliceCell(), "1/3 complete, 1 skipped");
});
