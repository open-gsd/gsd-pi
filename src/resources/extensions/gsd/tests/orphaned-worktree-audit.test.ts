// gsd-pi — Tests for auditOrphanedMilestoneBranches bootstrap audit
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { auditOrphanedMilestoneBranches } from "../auto-start.ts";
import { openDatabase, closeDatabase, insertMilestone, updateMilestoneStatus } from "../gsd-db.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/** Create a temp git repo with .gsd structure and DB. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orphan-audit-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);

  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);

  // Create .gsd structure on disk (not tracked in git)
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });

  return dir;
}

describe("auditOrphanedMilestoneBranches", () => {
  let dir: string;

  beforeEach(() => {
    dir = createRepo();
    openDatabase(join(dir, ".gsd", "gsd.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no milestone branches → no-op", () => {
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.actions, []);
    assert.equal(result.blockingStrandedWork, null);
  });

  test("runs in none isolation mode and cleans safe completed residue", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "none");
    assert.ok(
      result.recovered.some((r) => r.includes("Deleted merged branch milestone/M001")),
      `should clean merged completed residue even in none mode; got: ${JSON.stringify(result.recovered)}`,
    );
    assert.deepStrictEqual(result.warnings, []);
    assert.ok(
      result.actions.some((action) => action.kind === "complete-merged-branch"),
      "should record structured cleanup action",
    );

    const branches = run("git branch --list milestone/M001", dir);
    assert.equal(branches, "", "safe completed branch should be cleaned in none mode");
  });

  test("deletes merged branch for completed milestone", () => {
    // Create milestone branch from main (so it's already merged)
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.ok(result.recovered.length > 0, "should have recovered actions");
    assert.ok(
      result.recovered.some(r => r.includes("Deleted merged branch milestone/M001")),
      "should report branch deletion",
    );
    assert.deepStrictEqual(result.warnings, []);

    // Branch should be gone
    const branches = run("git branch --list milestone/M001", dir);
    assert.deepStrictEqual(branches, "", "branch should be deleted");
  });

  test("warns about unmerged branch for completed milestone", () => {
    // Create milestone branch with divergent commits (not merged into main)
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "new feature\n");
    run("git add feature.txt", dir);
    run("git commit -m \"add feature on milestone branch\"", dir);
    run("git checkout main", dir);

    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, [], "should not delete unmerged branch");
    assert.ok(result.warnings.length > 0, "should have warnings");
    assert.ok(
      result.warnings.some(w => w.includes("NOT merged")),
      "should warn about unmerged branch",
    );
    assert.ok(
      result.warnings.some(w => w.includes("/gsd doctor fix")),
      `warning should suggest the real remediation command; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings.every(w => !w.includes("/gsd health --fix")),
      `warning must not suggest the removed health --fix command; got: ${JSON.stringify(result.warnings)}`,
    );

    // Branch should still exist (data safety)
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "unmerged branch must be preserved");
  });

  test("skips active milestone branch with no commits ahead of main (nothing to recover)", () => {
    // Branch created from main with zero divergence — no live work, nothing to warn about.
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);

    // Branch should still exist (data safety — user may intend to use it)
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "active milestone branch should be preserved");
  });

  test("#4762 — warns about in-progress milestone with unmerged commits ahead of main", () => {
    // Simulates the primary #4761 scenario: auto-mode was interrupted mid-milestone.
    // DB status = active/in_progress, branch has real work, main is behind.
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "in-progress work\n");
    run("git add feature.txt", dir);
    run("git commit -m \"in-progress work on M001\"", dir);
    run("git checkout main", dir);

    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    // Must NOT recover/delete (data safety — work is live)
    assert.deepStrictEqual(result.recovered, [], "must not delete a branch with live in-progress work");

    // Must surface a warning so the user knows the worktree holds uncollapsed work
    assert.ok(result.warnings.length > 0, "should warn about in-progress orphan");
    assert.ok(
      result.warnings.some(w => w.includes("Stranded work") && w.includes("milestone/M001") && w.includes("in-progress")),
      `warning should mention stranded milestone/M001 and in-progress state; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.blockingStrandedWork?.milestoneId, "M001");
    // #812 — worktree-configured isolation must recover as "worktree" even when
    // the worktree directory is absent on disk, so recovery re-materializes the
    // worktree from the branch instead of checking it out in the project root.
    assert.equal(result.blockingStrandedWork?.recoveryMode, "worktree");
    assert.equal(result.blockingStrandedWork?.commitsAhead, 1);

    // Branch must still exist
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "in-progress branch must be preserved");
  });

  test("#812 — in-progress orphan under branch isolation recovers as branch", () => {
    // Same stranded scenario but the project is configured for branch-mode
    // isolation, where there is never a worktree to re-materialize. Recovery
    // must stay "branch".
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "in-progress work\n");
    run("git add feature.txt", dir);
    run("git commit -m \"in-progress work on M001\"", dir);
    run("git checkout main", dir);

    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "branch");

    assert.equal(result.blockingStrandedWork?.milestoneId, "M001");
    assert.equal(result.blockingStrandedWork?.recoveryMode, "branch");
  });

  test("#812-followup — worktree-mode project degrades to branch recovery when branch is already checked out at root", () => {
    // Simulates the leftover state from the pre-fix #812 recovery path: the
    // old code checked out milestone/<id> in the project root instead of
    // creating a worktree. On the next bootstrap:
    //   - isolationMode === "worktree"
    //   - HEAD at project root === "milestone/M001"
    //   - no linked worktree directory on disk
    //
    // Requesting worktree recovery in this state calls `git worktree add` for
    // a branch git already considers "in use by another worktree" (the main
    // worktree counts), causing bootstrap to abort with GSD_LOCK_HELD.
    // The fix detects the root checkout and degrades to "branch" so the
    // session resumes on the already-checked-out branch without failing.
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "in-progress work\n");
    run("git add feature.txt", dir);
    run("git commit -m \"in-progress work on M001\"", dir);
    // NOTE: stay on milestone/M001 — do NOT check out main.
    // This simulates the project root being on the milestone branch.

    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.equal(result.blockingStrandedWork?.milestoneId, "M001");
    // Must degrade to "branch" — worktree creation would fail because the
    // branch is already checked out at the project root.
    assert.equal(result.blockingStrandedWork?.recoveryMode, "branch");
  });

  test("#4762 — also surfaces worktree directory for in-progress orphan when present", () => {
    // In-progress + unmerged + physical worktree directory — the full primary scenario.
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "in-progress work\n");
    run("git add feature.txt", dir);
    run("git commit -m \"in-progress work on M001\"", dir);
    run("git checkout main", dir);

    // Simulate a leftover worktree directory
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, ".git"), `gitdir: ${join(dir, ".git", "worktrees", "M001")}\n`);

    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    // Must preserve everything for data safety
    assert.deepStrictEqual(result.recovered, [], "must not touch worktree or branch with live work");
    assert.ok(existsSync(wtDir), "worktree directory must be preserved");

    // Warning should mention the worktree path so the user can find the work
    assert.ok(
      result.warnings.some(w => w.includes(".gsd/worktrees/M001") || w.includes("worktree")),
      `warning should reference the worktree location; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.blockingStrandedWork?.recoveryMode, "worktree");
  });

  test("detects dirty in-progress worktree even when branch has no commits ahead", () => {
    run("git branch milestone/M001", dir);

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, ".git"), `gitdir: ${join(dir, ".git", "worktrees", "M001")}\n`);
    writeFileSync(join(wtDir, "dirty.txt"), "uncommitted work\n");

    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      hasChanges: (basePath) => basePath === wtDir,
    });

    assert.deepStrictEqual(result.recovered, []);
    assert.ok(
      result.warnings.some((w) => w.includes("uncommitted changes")),
      `dirty worktree should be treated as stranded work; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.blockingStrandedWork?.milestoneId, "M001");
    assert.equal(result.blockingStrandedWork?.dirtyWorktree, true);
    assert.equal(result.blockingStrandedWork?.recoveryMode, "worktree");
  });

  test("detects dirty in-progress worktree even when milestone branch is absent", () => {
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, ".git"), `gitdir: ${join(dir, ".git", "worktrees", "M001")}\n`);
    writeFileSync(join(wtDir, "dirty.txt"), "branchless work\n");

    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "none", {
      hasChanges: (basePath) => basePath === wtDir,
    });

    assert.deepStrictEqual(result.recovered, []);
    assert.ok(
      result.warnings.some((w) => w.includes("Stranded work") && w.includes("M001")),
      `branchless dirty worktree should block; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.blockingStrandedWork?.branch, undefined);
    assert.equal(result.blockingStrandedWork?.dirtyWorktree, true);
    assert.equal(result.blockingStrandedWork?.recoveryMode, "worktree");
  });

  test("cleans up orphaned worktree directory for merged milestone", () => {
    // Create milestone branch (merged — same as main)
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    // Create orphaned worktree directory
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "orphaned file\n");

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.ok(result.recovered.length > 0, "should have recovered actions");
    assert.ok(
      result.recovered.some(r => r.includes("worktree directory")),
      "should report worktree cleanup",
    );

    // Worktree directory should be cleaned up
    assert.ok(!existsSync(wtDir), "orphaned worktree directory should be removed");
  });

  test("handles multiple milestones with mixed states", () => {
    // M001: complete, branch merged → should clean up
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "First", status: "complete" });

    // M002: active, branch exists → should skip
    run("git branch milestone/M002", dir);
    insertMilestone({ id: "M002", title: "Second", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    // M001 should be cleaned up
    assert.ok(
      result.recovered.some(r => r.includes("M001")),
      "should clean up completed M001",
    );

    // M002 should not be touched
    const branches = run("git branch --list milestone/M002", dir);
    assert.ok(branches.includes("milestone/M002"), "active M002 branch should be preserved");
  });

  test("works in branch isolation mode", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "branch");

    assert.ok(result.recovered.length > 0, "should work in branch mode too");
    assert.ok(
      result.recovered.some(r => r.includes("Deleted merged branch")),
      "should delete branch in branch mode",
    );
  });

  test("milestone in DB, no branch, no worktree dir → no-op", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
  });

  test("#5879 — cleans orphaned worktree dir for complete milestone whose branch was already deleted", () => {
    // Reproduces the postflight-stash-restore-failed scenario:
    // 1. An earlier audit deleted milestone/M001 (merged + complete).
    // 2. The worktree dir cleanup failed silently (logWarning only).
    // 3. On the next startup the branch is gone, so the existing branch-keyed
    //    loop is invisible to the orphan dir. Without the second pass, the
    //    directory lives forever.
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "stranded from a prior session\n");

    // No milestone/M001 branch — already deleted on a previous run.
    const branches = run("git branch --list milestone/M001", dir);
    assert.equal(branches, "", "test fixture: branch should not exist");

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.ok(
      result.recovered.some((r) => r.includes("M001") && r.includes("branch already deleted")),
      `should report branch-less orphan cleanup; got: ${JSON.stringify(result.recovered)}`,
    );
    assert.ok(!existsSync(wtDir), "branch-less orphan worktree dir should be removed");
  });

  test("#5879 — branch list failure still cleans complete orphan only after branch absence is verified", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "stranded from a prior session\n");

    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      branchList: () => {
        throw new Error("branch list failed");
      },
      branchExists: (_basePath, branch) => {
        assert.equal(branch, "milestone/M001");
        return false;
      },
    });

    assert.ok(
      result.recovered.some((r) => r.includes("M001") && r.includes("branch already deleted")),
      `should report verified branch-less orphan cleanup; got: ${JSON.stringify(result.recovered)}`,
    );
    assert.ok(!existsSync(wtDir), "verified branch-less orphan worktree dir should be removed");
  });

  test("#5879 — branch list failure preserves complete worktree when branch still exists", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "live-work.txt"), "do not delete\n");

    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      branchList: () => {
        throw new Error("branch list failed");
      },
      branchExists: (_basePath, branch) => {
        assert.equal(branch, "milestone/M001");
        return true;
      },
    });

    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "worktree dir must be preserved when branch existence is verified");
  });

  test("#5879 — skips branch-less orphan for milestone that is not complete", () => {
    // Defensive: only `complete` milestones get the branch-less cleanup. An
    // `active` milestone with no branch but a worktree dir is a different
    // state (probably mid-recovery) and should not be silently wiped.
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "live-work.txt"), "do not delete\n");

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "active milestone worktree dir must be preserved");
  });

  test("#5879 — branch list failure does not delete worktree for milestone that is not complete", () => {
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "live-work.txt"), "do not delete\n");

    const result = auditOrphanedMilestoneBranches(dir, "worktree", {
      branchList: () => {
        throw new Error("branch list failed");
      },
      branchExists: () => {
        throw new Error("branchExists should not be called for active milestones");
      },
    });

    assert.deepStrictEqual(result.recovered, []);
    assert.ok(existsSync(wtDir), "active milestone worktree dir must be preserved");
  });

  test("#5879 — cleans branch-less complete orphan in 'none' isolation mode", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "stranded\n");

    const result = auditOrphanedMilestoneBranches(dir, "none");

    assert.ok(
      result.recovered.some((r) => r.includes("M001") && r.includes("branch already deleted")),
      `none mode should still clean safe completed residue; got: ${JSON.stringify(result.recovered)}`,
    );
    assert.ok(!existsSync(wtDir), "completed orphan worktree dir should be cleaned in none mode");
  });
});
