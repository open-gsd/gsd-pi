// Project/App: gsd-pi
// File Purpose: The execute-task GitHub comment is posted by the post-verification stage, when the task row is complete.

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { _resetConfigCache } from "../sync.ts";
import { _resetGhCache, _setGhAvailableForTest, _setGhRateLimitOkForTest } from "../cli.ts";
import { postUnitPostVerification, type PostUnitContext } from "../../gsd/auto-post-unit.ts";
import { AutoSession } from "../../gsd/auto/session.ts";
import { closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../../gsd/gsd-db.ts";
import { clearGSDPreferencesCache } from "../../gsd/preferences.ts";
import { cleanup, git, makeTempRepo } from "../../gsd/tests/test-utils.ts";

test("post-verification posts the comment of a verified execute-task from the task row", async (t) => {
  const base = makeTempRepo("gsd-task-comment-");
  const ghShimDir = mkdtempSync(join(tmpdir(), "gh-shim-"));
  const gsdHome = mkdtempSync(join(tmpdir(), "gsd-home-"));
  const ghLogPath = join(ghShimDir, "gh-invocations.log");
  const originalPath = process.env.PATH;
  const originalGsdHome = process.env.GSD_HOME;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalGsdHome !== undefined) process.env.GSD_HOME = originalGsdHome;
    else delete process.env.GSD_HOME;
    delete process.env.GSD_GH_LOG;
    _setGhAvailableForTest(null);
    _setGhRateLimitOkForTest(null);
    _resetGhCache();
    _resetConfigCache();
    clearGSDPreferencesCache();
    closeDatabase();
    cleanup(base);
    rmSync(ghShimDir, { recursive: true, force: true });
    rmSync(gsdHome, { recursive: true, force: true });
  });

  // Fake `gh` that records its args and succeeds.
  if (process.platform === "win32") {
    writeFileSync(join(ghShimDir, "gh.cmd"), ['@echo off', 'echo %* >> "%GSD_GH_LOG%"', 'exit /b 0', ''].join("\r\n"));
  } else {
    writeFileSync(join(ghShimDir, "gh"), ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$GSD_GH_LOG"', 'exit 0', ''].join("\n"));
    chmodSync(join(ghShimDir, "gh"), 0o755);
  }
  process.env.PATH = `${ghShimDir}${delimiter}${originalPath ?? ""}`;
  process.env.GSD_HOME = gsdHome;
  process.env.GSD_GH_LOG = ghLogPath;
  _resetGhCache();
  _resetConfigCache();
  clearGSDPreferencesCache();
  _setGhAvailableForTest(true);
  _setGhRateLimitOkForTest(true);

  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  git(base, "add", ".gitignore");
  git(base, "commit", "-m", "chore: ignore gsd runtime");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", "version: 1", "github:", "  enabled: true", "  repo: owner/repo", "---"].join("\n"),
  );
  writeFileSync(join(base, ".gsd", "github-sync.json"), JSON.stringify({
    version: 1,
    repo: "owner/repo",
    milestones: {},
    slices: {},
    tasks: { "M001/S01/T01": { issueNumber: 7, lastSyncedAt: "2025-01-01T00:00:00Z", state: "open" } },
  }));
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Platform", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "in_progress", sequence: 1 });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Add the form",
    status: "complete",
    fullSummaryMd: ["---", "id: T01", "---", "", "# T01: Add the form", "", "**Summary from the database**", ""].join("\n"),
  });

  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };
  const pctx: PostUnitContext = {
    s,
    ctx: { ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {} } } as unknown as PostUnitContext["ctx"],
    pi: {} as PostUnitContext["pi"],
    buildSnapshotOpts: () => ({}),
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };

  await postUnitPostVerification(pctx);

  const log = readFileSync(ghLogPath, "utf-8");
  assert.match(log, /issue comment 7 /);
  assert.match(log, /Summary from the database/);
});
