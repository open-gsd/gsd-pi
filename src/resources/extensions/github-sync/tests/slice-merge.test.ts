import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { runGitHubSync, _resetConfigCache } from "../sync.ts";
import {
  _resetGhCache,
  _setGhAvailableForTest,
  _setGhRateLimitOkForTest,
} from "../cli.ts";
import { clearGSDPreferencesCache } from "../../gsd/preferences.ts";

// Slice PRs must merge with the strategy the project chose via the
// `git.merge_strategy` preference (#2279), not a hardcoded squash.
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
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(ghShimDir, { recursive: true, force: true });
    rmSync(isolatedGsdHome, { recursive: true, force: true });
  });

  /** Seed prefs + mapping, run the complete-slice sync, return gh arg lines. */
  async function runSliceMergeScenario(preferencesLines: string[]): Promise<string[]> {
    writeFileSync(
      join(tmpDir, ".gsd", "PREFERENCES.md"),
      ["---", "version: 1", ...preferencesLines, "---"].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(tmpDir, ".gsd", "github-sync.json"),
      JSON.stringify(mappingWithSlicePr(), null, 2),
      "utf-8",
    );

    process.env.GSD_GH_LOG = ghLogPath;
    await runGitHubSync(tmpDir, "complete-slice", "M001/S01");

    let raw = "";
    try {
      raw = readFileSync(ghLogPath, "utf-8");
    } catch {
      raw = "";
    }
    return raw.split("\n").filter(Boolean);
  }

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
