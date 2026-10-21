// Project/App: gsd-pi
// File Purpose: Regression tests for milestone closeout settlement guidance.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { evaluateAllCompleteSettlement } from "../milestone-settlement.ts";
import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";

let base = "";

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(root: string): void {
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "# fixture\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "chore: init"]);
}

function seedClosedMilestone(root: string, worktree: string): void {
  mkdirSync(join(root, ".gsd"), { recursive: true });
  openDatabase(join(root, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice One", status: "complete" });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task One",
    status: "complete",
    verificationResult: "passed",
  });
  insertAssessment({
    path: ".gsd/milestones/M001/M001-VALIDATION.md",
    milestoneId: "M001",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass\n",
  });

  const worktreeMilestoneDir = join(worktree, ".gsd", "milestones", "M001");
  mkdirSync(worktreeMilestoneDir, { recursive: true });
  // A content-bearing legacy milestone dir requires at least one non-META file
  // (dirIsContentBearingLegacyMilestone) so the layout sniffer treats it as a
  // real legacy milestone rather than a metadata-only placeholder.
  writeFileSync(join(worktreeMilestoneDir, "M001-CONTEXT.md"), "# M001\n");
  const summaryPath = resolveExpectedArtifactPath("complete-milestone", "M001", worktree);
  assert.ok(summaryPath, "complete-milestone summary path should resolve");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, "# Milestone One\n\nComplete.\n");
}

afterEach(() => {
  try { closeDatabase(); } catch { /* ignore */ }
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

test("merge-pending settlement routes back to complete-milestone dispatch without manual merge guidance", () => {
  base = mkdtempSync(join(tmpdir(), "gsd-milestone-settlement-"));
  initRepo(base);
  const worktree = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(dirname(worktree), { recursive: true });
  runGit(base, ["worktree", "add", "-b", "milestone/M001", worktree, "HEAD"]);
  seedClosedMilestone(base, worktree);

  const result = evaluateAllCompleteSettlement({
    milestoneId: "M001",
    statePhase: "complete",
    basePath: worktree,
    originalBasePath: base,
    milestoneMerged: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "merge-pending");
  assert.equal(result.nextAction, "Retry `/gsd dispatch complete-milestone M001`.");
  assert.doesNotMatch(result.message, /merge manually/i);
  assert.doesNotMatch(result.nextAction, /merge manually/i);
});
