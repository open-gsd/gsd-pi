// Project/App: gsd-pi
// File Purpose: Doctor attempts safe conflict auto-resolution before hard-blocking auto-mode (#849).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { closeDatabase } from "../gsd-db.js";

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
}

function tryGit(args: string[], cwd: string): void {
  try {
    runGit(args, cwd);
  } catch {
    // Expected to fail for conflicting merges — the conflict state is what we want.
  }
}

function makeRepoWithConflict(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-autoresolve-"));
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);

  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, ".gsd", "STATE.md"), "base state\n", "utf-8");
  writeFileSync(join(base, "src", "app.js"), "base app\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);

  runGit(["checkout", "-b", "feature"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "feature state\n", "utf-8");
  writeFileSync(join(base, "src", "app.js"), "feature app\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: feature edits"], base);

  runGit(["checkout", "main"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "main state\n", "utf-8");
  writeFileSync(join(base, "src", "app.js"), "main app\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: main edits"], base);

  // Conflicting merge — leaves unmerged paths + MERGE_HEAD.
  tryGit(["merge", "feature"], base);
  return base;
}

test.after(() => {
  closeDatabase();
});

test("doctor auto-resolves safe .gsd/ conflicts and only blocks on manual paths", async (t) => {
  const base = makeRepoWithConflict();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const report = await runGSDDoctor(base, { isolationMode: "none" });

  const conflictIssue = report.issues.find((issue) => issue.code === "unresolved_git_conflicts");
  assert.ok(conflictIssue, "manual conflict should still be reported");
  assert.match(conflictIssue!.message, /src\/app\.js/, "manual path should be listed");
  assert.doesNotMatch(
    conflictIssue!.message,
    /\.gsd\/STATE\.md/,
    "safe .gsd/ path should have been auto-resolved out of the conflict list",
  );
});

test("doctor clears conflicts entirely when all unmerged paths are safe", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-autoresolve-safe-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "STATE.md"), "base\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);

  runGit(["checkout", "-b", "feature"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "feature\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: edit"], base);

  runGit(["checkout", "main"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "main\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: edit"], base);

  tryGit(["merge", "feature"], base);

  const report = await runGSDDoctor(base, { isolationMode: "none" });

  assert.ok(
    !report.issues.some((issue) => issue.code === "unresolved_git_conflicts"),
    "no manual conflicts should remain after safe auto-resolve",
  );
  assert.ok(
    !existsSync(join(base, ".git", "MERGE_HEAD")),
    "merge-state markers should be cleared in the same pass",
  );
});

test("doctor --dry-run does not mutate git state when safe conflicts are present", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-autoresolve-dryrun-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "STATE.md"), "base\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);

  runGit(["checkout", "-b", "feature"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "feature\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: edit"], base);

  runGit(["checkout", "main"], base);
  writeFileSync(join(base, ".gsd", "STATE.md"), "main\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "feat: edit"], base);

  tryGit(["merge", "feature"], base);

  // dry-run must not mutate git state even when all conflicts are safe
  const report = await runGSDDoctor(base, { dryRun: true, isolationMode: "none" });

  // MERGE_HEAD must still exist — dry-run is read-only
  assert.ok(
    existsSync(join(base, ".git", "MERGE_HEAD")),
    "dry-run must not clear merge-state markers",
  );
  // The conflict should still be reported (unresolved paths are reported as-is)
  assert.ok(
    report.issues.some((issue) => issue.code === "unresolved_git_conflicts"),
    "dry-run should still report the conflict without resolving it",
  );
});
