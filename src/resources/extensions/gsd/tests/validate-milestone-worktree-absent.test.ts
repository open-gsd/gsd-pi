// #2997 — when a worktree-isolated milestone's worktree directory is absent
// (torn down after auto exits), every resolveCanonicalMilestoneRoot consumer
// silently falls back to the project root — a checkout holding none of the
// milestone's code. Validation then records a pass labeled with the project
// root's revision and closeout blocks on validation-source-revision-mismatch
// against the real tree. The prompt builder and the tool must fail fast
// instead; the silent fallback stays only for milestones with no milestone
// branch (never isolated) or with the worktree present.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildValidateMilestonePrompt } from "../auto-prompts.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";
import { openDatabase, closeDatabase, insertMilestone } from "../gsd-db.ts";
import { makeTempRepo, git } from "./test-utils.ts";

function seed(base: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Isolated milestone", status: "active" });
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* best-effort */ }
  rmSync(base, { recursive: true, force: true });
}

test("validate-milestone tool refuses to run when the isolated milestone's worktree is absent (#2997)", async () => {
  const base = makeTempRepo("gsd-validate-wt-absent-");
  try {
    seed(base);
    git(base, "branch", "milestone/M001");

    const result = await handleValidateMilestone(
      {
        milestoneId: "M001",
        verdict: "pass",
        validationContent: "# Validation\n\n## Verdict\n\npass",
      } as never,
      base,
      {
        invocation: {
          idempotencyKey: "validate-wt-absent/case",
          sourceTransport: "internal",
          actorType: "agent",
          actorId: "validate-wt-absent-fixture",
        },
      } as never,
    );

    assert.ok("error" in result && result.error, "the tool must refuse");
    const message = (result as { error: string }).error;
    assert.match(message, /worktree is not present/);
    assert.match(message, /\/gsd auto/);
    assert.match(message, /milestone_worktree_absent/);
  } finally {
    cleanup(base);
  }
});

test("buildValidateMilestonePrompt throws when the isolated milestone's worktree is absent (#2997)", async () => {
  const base = makeTempRepo("gsd-validate-wt-absent-prompt-");
  try {
    seed(base);
    git(base, "branch", "milestone/M001");

    await assert.rejects(
      () => buildValidateMilestonePrompt("M001", "Isolated milestone", base),
      /worktree is not present[\s\S]*\/gsd auto/,
    );
  } finally {
    cleanup(base);
  }
});

test("validation proceeds normally without a milestone branch (never isolated) (#2997)", async (t) => {
  const base = makeTempRepo("gsd-validate-wt-none-");
  const savedCwd = process.cwd();
  process.chdir(base);
  t.after(() => {
    try { closeDatabase(); } catch { /* best-effort */ }
    process.chdir(savedCwd);
    rmSync(base, { recursive: true, force: true });
  });

  seed(base);

  const prompt = await buildValidateMilestonePrompt("M001", "Isolated milestone", base);
  assert.match(prompt, /Milestone Validation/, "the prompt must build without isolation");
});

test("branch-isolation mode (milestone branch checked out at the project root) validates normally (#2997)", async (t) => {
  const base = makeTempRepo("gsd-validate-wt-branchmode-");
  const savedCwd = process.cwd();
  process.chdir(base);
  t.after(() => {
    try { closeDatabase(); } catch { /* best-effort */ }
    process.chdir(savedCwd);
    rmSync(base, { recursive: true, force: true });
  });

  seed(base);
  git(base, "branch", "milestone/M001");
  // enterBranchModeForMilestone checks the milestone branch out at the
  // project root: the root IS the milestone tree, so validation runs.
  git(base, "checkout", "milestone/M001");

  const prompt = await buildValidateMilestonePrompt("M001", "Isolated milestone", base);
  assert.match(prompt, /Milestone Validation/, "branch-mode root checkouts must validate");
});

test("validation proceeds normally with the worktree present (#2997)", async (t) => {
  const base = makeTempRepo("gsd-validate-wt-present-");
  const savedCwd = process.cwd();
  process.chdir(base);
  t.after(() => {
    try { closeDatabase(); } catch { /* best-effort */ }
    process.chdir(savedCwd);
    rmSync(join(base, ".gsd-worktrees"), { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  seed(base);
  git(base, "branch", "milestone/M001");
  git(base, "worktree", "add", join(base, ".gsd-worktrees", "M001"), "milestone/M001");

  const prompt = await buildValidateMilestonePrompt("M001", "Isolated milestone", base);
  assert.match(prompt, /Milestone Validation/, "the prompt must build with the worktree present");
});
