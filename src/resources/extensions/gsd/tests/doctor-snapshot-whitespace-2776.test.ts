// Project/App: gsd-pi
// File Purpose: Doctor's stale-change snapshot gate blocks on leftover conflict markers only, never on whitespace or CRLF (#2776).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { closeDatabase } from "../gsd-db.js";

// Older than any stale_commit_threshold_minutes, so the snapshot gate always runs.
const STALE_COMMIT_DATE = "2020-01-01T00:00:00Z";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: STALE_COMMIT_DATE,
      GIT_COMMITTER_DATE: STALE_COMMIT_DATE,
    },
  }).trim();
}

function makeStaleRepo(prefix: string, trackedContent: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  // Keep the bytes written below exactly as they land in the diff, whatever
  // the machine-wide setting is (Git for Windows defaults to autocrlf=true).
  runGit(["config", "core.autocrlf", "false"], base);

  mkdirSync(join(base, "docs"), { recursive: true });
  writeFileSync(join(base, "docs", "ARCHITECTURE.md"), trackedContent, "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);
  return base;
}

function headSubject(base: string): string {
  return runGit(["log", "-1", "--format=%s"], base);
}

test.after(() => {
  closeDatabase();
});

test("doctor does not report conflict markers for trailing whitespace in tracked changes", async (t) => {
  const base = makeStaleRepo("gsd-doctor-snapshot-ws-", "# Architecture\n\nOne layer.\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeFileSync(join(base, "docs", "ARCHITECTURE.md"), "# Architecture\n\nTwo layers.   \n", "utf-8");

  const report = await runGSDDoctor(base, { isolationMode: "none" });

  assert.ok(
    report.issues.some((issue) => issue.code === "stale_uncommitted_changes"),
    "the stale-change snapshot gate should have run",
  );
  assert.deepEqual(
    report.issues.filter((issue) => issue.code === "conflict_markers_in_tracked_files"),
    [],
    "trailing whitespace is not a merge conflict",
  );
});

test("doctor --fix snapshots tracked changes that only have trailing whitespace", async (t) => {
  const base = makeStaleRepo("gsd-doctor-snapshot-ws-fix-", "# Architecture\n\nOne layer.\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeFileSync(join(base, "docs", "ARCHITECTURE.md"), "# Architecture\n\nTwo layers.   \n", "utf-8");

  const report = await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  assert.deepEqual(
    report.issues.filter((issue) => issue.code === "conflict_markers_in_tracked_files"),
    [],
  );
  assert.match(headSubject(base), /^gsd snapshot: /, "the safety snapshot commit should be created");
  assert.equal(
    runGit(["status", "--porcelain", "--", "docs/ARCHITECTURE.md"], base),
    "",
    "the whitespace change should be captured by the snapshot",
  );
});

test("doctor does not report conflict markers for a tracked file rewritten with CRLF", async (t) => {
  // The Windows shape of the same defect: with core.autocrlf=false git reports
  // the CR on every rewritten line as trailing whitespace.
  const base = makeStaleRepo("gsd-doctor-snapshot-crlf-", "# Architecture\n\nOne layer.\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeFileSync(join(base, "docs", "ARCHITECTURE.md"), "# Architecture\r\n\r\nTwo layers.\r\n", "utf-8");

  const report = await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  assert.deepEqual(
    report.issues.filter((issue) => issue.code === "conflict_markers_in_tracked_files"),
    [],
    "CRLF line endings are not a merge conflict",
  );
  assert.match(headSubject(base), /^gsd snapshot: /, "the safety snapshot commit should be created");
});

test("doctor still blocks the snapshot on a leftover conflict marker and lists only the marker lines", async (t) => {
  const base = makeStaleRepo("gsd-doctor-snapshot-marker-", "# Architecture\n\nOne layer.\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeFileSync(
    join(base, "docs", "ARCHITECTURE.md"),
    [
      "# Architecture",
      "",
      "<<<<<<< HEAD",
      "Two layers.   ",
      "=======",
      "Three layers.",
      ">>>>>>> feature",
      "",
    ].join("\n"),
    "utf-8",
  );

  const report = await runGSDDoctor(base, { fix: true, isolationMode: "none" });

  const markerIssues = report.issues.filter((issue) => issue.code === "conflict_markers_in_tracked_files");
  assert.equal(markerIssues.length, 1, "a real leftover conflict marker must still be reported");
  assert.equal(markerIssues[0]!.severity, "error");
  assert.equal(markerIssues[0]!.fixable, false);
  assert.match(markerIssues[0]!.message, /docs\/ARCHITECTURE\.md:3: leftover conflict marker/);
  assert.doesNotMatch(
    markerIssues[0]!.message,
    /trailing whitespace/,
    "whitespace findings on the same file should not be reported as conflicts",
  );
  assert.equal(headSubject(base), "chore: init", "no snapshot commit while conflict markers remain");
});
