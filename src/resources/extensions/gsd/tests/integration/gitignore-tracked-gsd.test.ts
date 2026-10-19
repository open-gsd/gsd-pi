/**
 * gitignore-tracked-gsd.test.ts — Regression tests for #1364.
 *
 * Verifies that ensureGitignore() does NOT add ".gsd" to .gitignore
 * when .gsd/ contains git-tracked files, and that migrateToExternalState()
 * aborts migration for tracked .gsd/ directories.
 *
 * Uses real temporary git repos — no mocks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { ensureGitignore, hasGitTrackedGsdFiles, untrackRuntimeFiles } from "../../gitignore.ts";
import { migrateToExternalState } from "../../migrate-external.ts";
import { RUNTIME_EXCLUSION_PATHS } from "../../git-service.ts";
import { nativeAddAllWithExclusions } from "../../native-git-bridge.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" }).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-gitignore-test-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# init\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "branch", "-M", "main");
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── hasGitTrackedGsdFiles ───────────────────────────────────────────

test("hasGitTrackedGsdFiles returns false when .gsd/ does not exist", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  assert.equal(hasGitTrackedGsdFiles(dir), false);
});

test("hasGitTrackedGsdFiles returns true when .gsd/ has tracked files", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test Project\n");
  git(dir, "add", ".gsd/PROJECT.md");
  git(dir, "commit", "-m", "add gsd");
  assert.equal(hasGitTrackedGsdFiles(dir), true);
});

test("hasGitTrackedGsdFiles returns false when .gsd/ exists but is untracked", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "state\n");
  // Not git-added — should return false
  assert.equal(hasGitTrackedGsdFiles(dir), false);
});

// ─── ensureGitignore — tracked .gsd/ protection ─────────────────────

test("ensureGitignore does NOT add .gsd when .gsd/ has tracked files (#1364)", (t) => {
  const dir = makeTempRepo();
  try {
    // Set up .gsd/ with tracked files
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test Project\n");
    writeFileSync(join(dir, ".gsd", "DECISIONS.md"), "# Decisions\n");
    git(dir, "add", ".gsd/");
    git(dir, "commit", "-m", "track gsd state");

    // Run ensureGitignore
    ensureGitignore(dir);

    // Verify .gsd is NOT in .gitignore
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    const lines = gitignore.split("\n").map((l) => l.trim());
    assert.ok(
      !lines.includes(".gsd"),
      `Expected .gsd NOT to appear in .gitignore, but it does:\n${gitignore}`,
    );

    // Other baseline patterns should still be present
    assert.ok(lines.includes(".DS_Store"), "Expected .DS_Store in .gitignore");
    assert.ok(lines.includes("node_modules/"), "Expected node_modules/ in .gitignore");
    assert.ok(lines.includes(".mcp.json"), "Expected .mcp.json in .gitignore");
  } finally {
    cleanup(dir);
  }
});

test("ensureGitignore adds granular runtime patterns when .gsd/ has tracked files", (t) => {
  // Regression: pre-completion close-out gate (auto-dispatch.ts) blocks when
  // RUNTIME_EXCLUSION_PATHS artifacts appear as untracked. They are excluded
  // from smartStage by design, so the auto-commit can never absorb them; the
  // umbrella .gsd ignore pattern would normally cover them, but it is stripped
  // when .gsd/ has tracked files. Without a granular fallback, runtime paths
  // surface as `??` in `git status` and trip the close-out gate forever.
  const dir = makeTempRepo();
  try {
    // Set up .gsd/ with tracked files (mirrors the close-out smoke scenario).
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test Project\n");
    git(dir, "add", ".gsd/");
    git(dir, "commit", "-m", "track gsd state");

    ensureGitignore(dir);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    const lines = new Set(gitignore.split("\n").map((l) => l.trim()));

    // The umbrella pattern must still be omitted (preserves #1364).
    assert.ok(!lines.has(".gsd"), `.gsd should not appear when tracked; got:\n${gitignore}`);

    // The runtime artifacts that break the close-out gate must be ignored.
    for (const pattern of [
      ".gsd/STATE.md",
      ".gsd/runtime/",
      ".gsd/activity/",
      ".gsd/audit/",
      ".gsd/journal/",
      ".gsd/gsd.db*",
      ".gsd/event-log.jsonl",
      ".gsd/metrics.json",
      ".gsd/state-manifest.json",
      // #2829 — exec/notify/hook/audit runtime writers in tracked-.gsd projects
      ".gsd/exec/",
      ".gsd/safety/",
      ".gsd/graphs/",
      ".gsd/migration/projection-mutations/",
      ".gsd/migration/quarantined-control-publications/",
      ".gsd/migration/native-projection-evidence/",
      ".gsd/migration/managed-outputs.json",
      ".gsd/migration/unbound-projection-evidence.json",
      ".gsd/notifications.jsonl",
      ".gsd/notifications.lock",
      ".gsd/notifications.jsonl.tmp.*",
      ".gsd/hook-state.json",
      ".gsd/audit-log.jsonl",
      ".gsd/lifecycle-shadow-observation-loss.jsonl",
      ".gsd/git-action-failures.log",
    ]) {
      assert.ok(
        lines.has(pattern),
        `Expected ${pattern} in .gitignore so close-out gate sees a clean tree; got:\n${gitignore}`,
      );
    }

    // BASELINE and GSD_RUNTIME both contain .gsd-worktrees/ — must not duplicate.
    const worktreeOccurrences = gitignore
      .split("\n")
      .filter((l) => l.trim() === ".gsd-worktrees/").length;
    assert.equal(
      worktreeOccurrences,
      1,
      `.gsd-worktrees/ should appear exactly once; got ${worktreeOccurrences} in:\n${gitignore}`,
    );
  } finally {
    cleanup(dir);
  }
});

test("ensureGitignore adds .gsd when .gsd/ has NO tracked files", (t) => {
  const dir = makeTempRepo();
  try {
    // Run ensureGitignore (no .gsd/ at all)
    ensureGitignore(dir);

    // Verify .gsd IS in .gitignore
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    const lines = gitignore.split("\n").map((l) => l.trim());
    assert.ok(
      lines.includes(".gsd"),
      `Expected .gsd in .gitignore, but it's missing:\n${gitignore}`,
    );
  } finally {
    cleanup(dir);
  }
});

test("ensureGitignore respects manageGitignore: false", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  const result = ensureGitignore(dir, { manageGitignore: false });
  assert.equal(result, false);
  assert.ok(!existsSync(join(dir, ".gitignore")), "Should not create .gitignore");
});

// ─── ensureGitignore — verify no tracked files become invisible ─────

test("ensureGitignore with tracked .gsd/ does not cause git to see files as deleted", (t) => {
  const dir = makeTempRepo();
  try {
    // Create tracked .gsd/ files
    mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Project\n");
    writeFileSync(
      join(dir, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
      "# M001\n",
    );
    git(dir, "add", ".gsd/");
    git(dir, "commit", "-m", "track gsd state");

    // Run ensureGitignore
    ensureGitignore(dir);

    // git status should show NO deleted files under .gsd/
    const status = git(dir, "status", "--porcelain", ".gsd/");

    // Filter for deletions (lines starting with " D" or "D ")
    const deletions = status
      .split("\n")
      .filter((l) => l.match(/^\s*D\s/) || l.match(/^D\s/));

    assert.equal(
      deletions.length,
      0,
      `Expected no deleted .gsd/ files, but found:\n${deletions.join("\n")}`,
    );
  } finally {
    cleanup(dir);
  }
});

test("hasGitTrackedGsdFiles returns true (fail-safe) when git is not available", (t) => {
  const dir = makeTempRepo();
  try {
    // Create and track .gsd/ files
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Project\n");
    git(dir, "add", ".gsd/");
    git(dir, "commit", "-m", "track gsd");

    // Corrupt the git index to simulate git failure
    const indexPath = join(dir, ".git", "index.lock");
    writeFileSync(indexPath, "locked");

    // Should fail safe — assume tracked rather than silently returning false
    // (The index lock causes git ls-files to fail; rev-parse also fails → true)
    const result = hasGitTrackedGsdFiles(dir);
    assert.equal(result, true, "Should return true (fail-safe) when git is unavailable");
  } finally {
    cleanup(dir);
  }
});

// ─── migrateToExternalState — tracked .gsd/ protection ──────────────

test("migrateToExternalState aborts when .gsd/ has tracked files (#1364)", (t) => {
  const dir = makeTempRepo();
  try {
    // Create tracked .gsd/ files
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Project\n");
    git(dir, "add", ".gsd/");
    git(dir, "commit", "-m", "track gsd state");

    // Attempt migration — should abort without moving anything
    const result = migrateToExternalState(dir);

    assert.equal(result.migrated, false, "Should NOT migrate tracked .gsd/");
    assert.equal(result.error, undefined, "Should not report an error — just skip");

    // .gsd/ should still be a real directory, not a symlink
    assert.ok(existsSync(join(dir, ".gsd", "PROJECT.md")), ".gsd/PROJECT.md should still exist");

    // No .gsd.migrating should exist
    assert.ok(
      !existsSync(join(dir, ".gsd.migrating")),
      ".gsd.migrating should not exist",
    );
  } finally {
    cleanup(dir);
  }
});

test("migrateToExternalState cleans git index so tracked files don't show as deleted (#1364 path 2)", (t) => {
  const dir = makeTempRepo();
  try {
    // Track .gsd/ files, then untrack them so migration proceeds
    mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Project\n");
    writeFileSync(join(dir, ".gsd", "milestones", "M001", "PLAN.md"), "# Plan\n");
    git(dir, "add", ".gsd/");
    git(dir, "commit", "-m", "track gsd state");
    git(dir, "rm", "-r", "--cached", ".gsd/");
    git(dir, "commit", "-m", "untrack gsd (simulates pre-migration project)");

    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, true, "Migration should succeed");

    // git status must show NO deleted files after migration
    const status = git(dir, "status", "--porcelain");
    const deletions = status.split("\n").filter((l) => /^\s*D\s/.test(l) || /^D\s/.test(l));
    assert.equal(
      deletions.length,
      0,
      `Expected no deleted files after migration, but found:\n${deletions.join("\n")}`,
    );
  } finally {
    cleanup(dir);
  }
});

// ─── #2829 — runtime files written into tracked .gsd/ must not commit ──

/** The runtime artifacts the #2829 reporters saw land in auto-commits. */
const GSD_2829_RUNTIME_FILES = [
  ".gsd/exec/run-1.stdout",
  ".gsd/exec/run-1.stderr",
  ".gsd/exec/run-1.meta.json",
  ".gsd/notifications.jsonl",
  ".gsd/notifications.lock",
  ".gsd/notifications.jsonl.tmp.4242",
  ".gsd/hook-state.json",
  ".gsd/audit-log.jsonl",
  ".gsd/safety/evidence-M001-S01-T01.json",
  ".gsd/graphs/graph.json",
  ".gsd/migration/projection-mutations/op-1.json",
  ".gsd/migration/unbound-projection-evidence.json",
  ".gsd/lifecycle-shadow-observation-loss.jsonl",
  ".gsd/git-action-failures.log",
];

function write2829RuntimeFiles(dir: string): void {
  for (const rel of GSD_2829_RUNTIME_FILES) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{}\n");
  }
}

test("staging excludes #2829 runtime files in a tracked-.gsd repo", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  // Tracked .gsd/ markdown (the project deliberately commits its .gsd/ docs)
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test Project\n");
  git(dir, "add", ".gsd/");
  git(dir, "commit", "-m", "track gsd state");

  // Runtime artifacts appear, plus a real source change
  write2829RuntimeFiles(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export {};\n");

  // GSD staging: add-all with the runtime exclusions (same path smartStage uses)
  nativeAddAllWithExclusions(dir, RUNTIME_EXCLUSION_PATHS);
  git(dir, "commit", "-m", "work");

  const tracked = new Set(
    git(dir, "ls-files").split("\n").map((l) => l.trim()).filter(Boolean),
  );

  assert.ok(tracked.has("src/app.ts"), "real source change must be committed");
  for (const rel of GSD_2829_RUNTIME_FILES) {
    assert.ok(
      !tracked.has(rel),
      `runtime file ${rel} must not be committed (found in ls-files)`,
    );
  }
});

test("untrackRuntimeFiles untracks the #2829 runtime paths from the index", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  // Simulate a repo that already committed the runtime files before the fix
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test Project\n");
  write2829RuntimeFiles(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "accidentally committed runtime files");

  untrackRuntimeFiles(dir);

  const tracked = new Set(
    git(dir, "ls-files").split("\n").map((l) => l.trim()).filter(Boolean),
  );
  assert.ok(tracked.has(".gsd/PROJECT.md"), "durable .gsd/ markdown stays tracked");
  for (const rel of GSD_2829_RUNTIME_FILES) {
    assert.ok(
      !tracked.has(rel),
      `runtime file ${rel} must be untracked (still in ls-files)`,
    );
  }
});
