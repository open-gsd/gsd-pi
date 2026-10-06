// Project/App: gsd-pi
// File Purpose: Stop-auto worktree exit strategy regression tests.
/**
 * stop-auto-merge-back.test.ts — Regression test for #5576.
 *
 * When auto-mode stops after a milestone is complete, stopAuto should trigger
 * merge-back (mergeAndExit) instead of just exiting the worktree with
 * preserveBranch: true. Otherwise milestone code stays stranded on the
 * worktree branch and never reaches main.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resolveStopAutoMilestoneId, _selectStopAutoWorktreeExit, stopAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { resolveMilestoneFile } from "../paths.ts";
import { WorktreeLifecycle } from "../worktree-lifecycle.ts";

test("#5576: stopAuto should check milestone completion status before choosing exit strategy", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: true,
      milestoneMergedInPhases: false,
    }),
    "merge",
  );
});

test("#5576: stopAuto still preserves branch for incomplete milestones", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: false,
      milestoneMergedInPhases: false,
    }),
    "preserve",
  );
});

test("#5576: stopAuto does not merge a milestone already merged in phases", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: true,
      milestoneMergedInPhases: true,
    }),
    "none",
  );
});

test("stopAuto preserves a complete milestone when merge cleanup is explicitly suppressed", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: true,
      milestoneMergedInPhases: false,
      preserveCompletedMilestoneBranch: true,
    }),
    "preserve",
  );
});

test("#5576: stopAuto skips worktree teardown when no milestone is active", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: null,
      milestoneComplete: true,
      milestoneMergedInPhases: false,
    }),
    "none",
  );
});

test("#5576: stopAuto returns none when phases are already merged even if milestone is not flagged complete", () => {
  assert.equal(
    _selectStopAutoWorktreeExit({
      currentMilestoneId: "M001",
      milestoneComplete: false,
      milestoneMergedInPhases: true,
    }),
    "none",
  );
});

test("#6273: stopAuto infers milestone id from milestone worktree path when session milestone id is missing", () => {
  assert.equal(
    _resolveStopAutoMilestoneId(null, "/repo/.gsd/worktrees/M001"),
    "M001",
  );
});

test("#6273: stopAuto does not infer non-milestone worktree names", () => {
  assert.equal(
    _resolveStopAutoMilestoneId(null, "/repo/.gsd/worktrees/feature-x"),
    null,
  );
});

test("stopAuto preserves the branch instead of merging when the DB is unavailable, even with a SUMMARY on disk", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stop-no-db-"));
  const previousCwd = process.cwd();
  const exits: Array<{ milestoneId: string; merge: boolean }> = [];
  t.mock.method(WorktreeLifecycle.prototype, "exitMilestone", (milestoneId: string, opts: { merge: boolean }) => {
    exits.push({ milestoneId, merge: opts.merge });
    return { ok: true };
  });
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", () => {});
  t.after(() => {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "---\nid: M001\n---\n\n# M001 — Complete\n", "utf-8");
  closeDatabase();

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";

  await stopAuto(
    { hasUI: false, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setHeader: () => {} } } as any,
    undefined,
    "test stop",
  );

  assert.deepEqual(exits, [{ milestoneId: "M001", merge: false }], "no DB must preserve, never merge");
});

test("stopAuto renders the project-root projections from the database after it merges a complete milestone", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-stop-merge-rebuild-"));
  const previousCwd = process.cwd();
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  // The merge brings in a tracked projection file whose content is not the database content.
  t.mock.method(WorktreeLifecycle.prototype, "exitMilestone", () => {
    writeFileSync(roadmapPath, "# M001\n\n## Slices\n- [ ] **S01: Merged file slice**\n", "utf-8");
    return { ok: true };
  });
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", () => {});
  t.after(() => {
    autoSession.reset();
    closeDatabase();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  });

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Stop merge", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Database slice", status: "complete", risk: "low", depends: [], demo: "demo", sequence: 1 });

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";

  await stopAuto(
    { hasUI: false, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setHeader: () => {} } } as any,
    undefined,
    "test stop",
  );

  const rendered = resolveMilestoneFile(base, "M001", "ROADMAP");
  assert.ok(rendered, "the stop merge renders the root ROADMAP");
  const roadmap = readFileSync(rendered, "utf-8");
  assert.match(roadmap, /Database slice/, "the root ROADMAP is the database render after the stop merge");
  assert.doesNotMatch(roadmap, /Merged file slice/);
});
