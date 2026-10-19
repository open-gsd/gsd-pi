import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapSync, runGitHubSync, _resetConfigCache } from "../sync.ts";
import {
  _resetGhCache,
  _setGhAvailableForTest,
  _setGhRateLimitOkForTest,
} from "../cli.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../../gsd/gsd-db.ts";
import { clearGSDPreferencesCache } from "../../gsd/preferences.ts";

// Slice PRs must merge with the strategy the project chose via the
// `git.merge_strategy` preference (#2279), not a hardcoded squash.
// The database decides whether the slice is complete: a slice that is not
// complete there is not merged, whatever the unit type or the files say.
// These tests drive the real sync flow with a fake `gh` shim on PATH
// that records every invocation, so the actual `gh pr merge` args are
// asserted end-to-end.

function mappingWithSlicePr(): object {
  return {
    version: 1,
    repo: "owner/repo",
    milestones: {},
    slices: {
      "M001/S01": {
        issueNumber: 0,
        prNumber: 42,
        branch: "milestone/M001/S01",
        lastSyncedAt: "2025-01-01T00:00:00Z",
        state: "open",
      },
    },
    tasks: {},
  };
}

describe("slice PR merge strategy (#2279)", () => {
  let tmpDir: string;
  let ghShimDir: string;
  let ghLogPath: string;
  let isolatedGsdHome: string;
  let originalPath: string | undefined;
  let originalGsdHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-slice-merge-"));
    ghShimDir = mkdtempSync(join(tmpdir(), "gh-shim-"));
    ghLogPath = join(ghShimDir, "gh-invocations.log");
    isolatedGsdHome = mkdtempSync(join(tmpdir(), "gsd-home-"));
    mkdirSync(join(tmpDir, ".gsd"), { recursive: true });

    // Fake `gh` that records its args and succeeds. Platform-aware: POSIX
    // gets a sh script, Windows gets a batch file (cmd.exe).
    if (process.platform === "win32") {
      // The space before `>>` keeps cmd.exe from reading a trailing digit
      // in the args (e.g. "pr ready 42") as an fd-redirection prefix.
      writeFileSync(
        join(ghShimDir, "gh.cmd"),
        ['@echo off', 'echo %* >> "%GSD_GH_LOG%"', 'exit /b 0', ''].join("\r\n"),
      );
    } else {
      writeFileSync(
        join(ghShimDir, "gh"),
        ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$GSD_GH_LOG"', 'exit 0', ''].join("\n"),
        { mode: 0o755 },
      );
      chmodSync(join(ghShimDir, "gh"), 0o755);
    }

    originalPath = process.env.PATH;
    originalGsdHome = process.env.GSD_HOME;
    process.env.PATH = `${ghShimDir}${delimiter}${originalPath ?? ""}`;
    process.env.GSD_HOME = isolatedGsdHome;

    _resetGhCache();
    _resetConfigCache();
    clearGSDPreferencesCache();
    _setGhAvailableForTest(true);
    _setGhRateLimitOkForTest(true);
  });

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    if (originalGsdHome !== undefined) process.env.GSD_HOME = originalGsdHome;
    else delete process.env.GSD_HOME;
    delete process.env.GSD_GH_LOG;
    _setGhAvailableForTest(null);
    _setGhRateLimitOkForTest(null);
    _resetGhCache();
    _resetConfigCache();
    clearGSDPreferencesCache();
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(ghShimDir, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  });

  /** Seed prefs + mapping, run the complete-slice sync, return gh arg lines. */
  function writePreferences(preferencesLines: string[]): void {
    writeFileSync(
      join(tmpDir, ".gsd", "PREFERENCES.md"),
      ["---", "version: 1", ...preferencesLines, "---"].join("\n"),
      "utf-8",
    );
  }

  function ghLines(): string[] {
    let raw = "";
    try {
      raw = readFileSync(ghLogPath, "utf-8");
    } catch {
      raw = "";
    }
    return raw.split("\n").filter(Boolean);
  }

  /** Seed prefs + mapping + the slice row, run the complete-slice sync, return gh arg lines. */
  async function runSliceMergeScenario(preferencesLines: string[], sliceStatus = "complete"): Promise<string[]> {
    writePreferences(preferencesLines);
    writeFileSync(
      join(tmpDir, ".gsd", "github-sync.json"),
      JSON.stringify(mappingWithSlicePr(), null, 2),
      "utf-8",
    );
    assert.equal(openDatabase(join(tmpDir, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Platform", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: sliceStatus, sequence: 1 });
    _getAdapter()!.prepare(
      "UPDATE slices SET full_summary_md = :summary WHERE milestone_id = 'M001' AND id = 'S01'",
    ).run({
      ":summary": ["---", "id: S01", "---", "", "# S01: Foundation", "", "**Summary from the database**", ""].join("\n"),
    });

    process.env.GSD_GH_LOG = ghLogPath;
    await runGitHubSync(tmpDir, "complete-slice", "M001/S01");
    return ghLines();
  }

  const SLICE_PR_PREFERENCES = ["github:", "  enabled: true", "  repo: owner/repo", "  slice_prs: true"];

  it("does not merge or publish the PR of a slice that is not complete in the database", async () => {
    // The SUMMARY projection exists, as after a complete-slice unit that wrote
    // the file but did not complete the slice.
    const sliceDir = join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01: Foundation\n\n**Summary from the file**\n");

    const lines = await runSliceMergeScenario(SLICE_PR_PREFERENCES, "in_progress");

    assert.deepEqual(lines, [], `no gh call is expected, got: ${JSON.stringify(lines)}`);
    const mapping = JSON.parse(readFileSync(join(tmpDir, ".gsd", "github-sync.json"), "utf-8"));
    assert.equal(mapping.slices["M001/S01"].state, "open");
  });

  it("posts the summary stored on the slice row, not the SUMMARY.md file", async () => {
    const sliceDir = join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01: Foundation\n\n**Summary from the file**\n");

    const log = (await runSliceMergeScenario(SLICE_PR_PREFERENCES)).join("\n");

    assert.match(log, /issue comment 42 /);
    assert.match(log, /Summary from the database/);
    assert.doesNotMatch(log, /Summary from the file/);
  });

  /** Seed prefs, a task issue mapping, the task row and a contradicting SUMMARY.md, then run the execute-task sync. */
  async function runTaskCompleteScenario(taskStatus: string): Promise<string[]> {
    writePreferences(["github:", "  enabled: true", "  repo: owner/repo"]);
    writeFileSync(
      join(tmpDir, ".gsd", "github-sync.json"),
      JSON.stringify({
        version: 1,
        repo: "owner/repo",
        milestones: {},
        slices: {},
        tasks: { "M001/S01/T01": { issueNumber: 7, lastSyncedAt: "2025-01-01T00:00:00Z", state: "open" } },
      }),
      "utf-8",
    );
    const taskDir = join(tmpDir, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "T01-SUMMARY.md"), "# T01: Add the form\n\n**Summary from the file**\n");
    assert.equal(openDatabase(join(tmpDir, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Platform", status: "active" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "in_progress", sequence: 1 });
    insertTask({
      milestoneId: "M001",
      sliceId: "S01",
      id: "T01",
      title: "Add the form",
      status: taskStatus,
      fullSummaryMd: ["---", "id: T01", "---", "", "# T01: Add the form", "", "**Summary from the database**", ""].join("\n"),
    });

    process.env.GSD_GH_LOG = ghLogPath;
    await runGitHubSync(tmpDir, "execute-task", "M001/S01/T01");
    return ghLines();
  }

  it("does not comment on the issue of a task that is not complete in the database", async () => {
    // The SUMMARY projection exists, as after an execute-task unit that
    // staged its result but did not pass host verification.
    const lines = await runTaskCompleteScenario("pending");

    assert.deepEqual(lines, [], `no gh call is expected, got: ${JSON.stringify(lines)}`);
  });

  it("posts the summary stored on the task row, not the SUMMARY.md file", async () => {
    const log = (await runTaskCompleteScenario("complete")).join("\n");

    assert.match(log, /issue comment 7 /);
    assert.match(log, /Summary from the database/);
    assert.doesNotMatch(log, /Summary from the file/);
  });

  it("bootstrap creates entities for database milestones and slices that have no directory", async () => {
    writePreferences(["github:", "  enabled: true", "  repo: owner/repo"]);
    assert.equal(openDatabase(join(tmpDir, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Platform", status: "active" });
    insertMilestone({ id: "M002", title: "Dropped", status: "cancelled" });
    insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "pending", sequence: 1 });
    process.env.GSD_GH_LOG = ghLogPath;

    const counts = await bootstrapSync(tmpDir);

    assert.deepEqual({ milestones: counts.milestones, slices: counts.slices }, { milestones: 1, slices: 1 });
    assert.ok(ghLines().length > 0, "the sync called gh for the database milestone");
  });

  it("merges with --merge when git.merge_strategy is merge", async () => {
    const lines = await runSliceMergeScenario([
      "github:",
      "  enabled: true",
      "  repo: owner/repo",
      "  slice_prs: true",
      "git:",
      "  merge_strategy: merge",
    ]);

    const mergeLine = lines.find((l) => l.startsWith("pr merge 42"));
    assert.ok(mergeLine, `expected a 'gh pr merge' invocation, got: ${JSON.stringify(lines)}`);
    assert.ok(mergeLine.includes("--merge"), `expected --merge in: ${mergeLine}`);
    assert.ok(!mergeLine.includes("--squash"), `squash must not be used when merge is preferred: ${mergeLine}`);
    assert.ok(mergeLine.includes("--delete-branch"), `deletion flag must stay unchanged: ${mergeLine}`);
  });

  it("defaults to --squash when git.merge_strategy is unset", async () => {
    const lines = await runSliceMergeScenario([
      "github:",
      "  enabled: true",
      "  repo: owner/repo",
      "  slice_prs: true",
    ]);

    const mergeLine = lines.find((l) => l.startsWith("pr merge 42"));
    assert.ok(mergeLine, `expected a 'gh pr merge' invocation, got: ${JSON.stringify(lines)}`);
    assert.ok(mergeLine.includes("--squash"), `expected default --squash in: ${mergeLine}`);
    assert.ok(mergeLine.includes("--delete-branch"), `deletion flag must stay unchanged: ${mergeLine}`);
  });

  it("merges with --squash when git.merge_strategy is squash", async () => {
    const lines = await runSliceMergeScenario([
      "github:",
      "  enabled: true",
      "  repo: owner/repo",
      "  slice_prs: true",
      "git:",
      "  merge_strategy: squash",
    ]);

    const mergeLine = lines.find((l) => l.startsWith("pr merge 42"));
    assert.ok(mergeLine, `expected a 'gh pr merge' invocation, got: ${JSON.stringify(lines)}`);
    assert.ok(mergeLine.includes("--squash"), `expected explicit squash in: ${mergeLine}`);
    assert.ok(mergeLine.includes("--delete-branch"), `deletion flag must stay unchanged: ${mergeLine}`);
  });
});
