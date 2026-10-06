import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pauseAuto } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { postUnitPreVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { _getAdapter, closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";
import { extractSourceRegion } from "./test-helpers.ts";

const source = readFileSync(
  join(import.meta.dirname, "..", "auto-post-unit.ts"),
  "utf-8",
);

test("a failed closeout git action pauses auto-mode with the blocker kind machine_fixable", async (t) => {
  const base = makeTempRepo("gsd-post-unit-git-failure-");
  const previousCwd = process.cwd();
  t.after(() => {
    autoSession.reset();
    try { closeDatabase(); } catch { /* already closed */ }
    process.chdir(previousCwd);
    cleanup(base);
  });

  writeFileSync(join(base, ".gitignore"), ".gsd/\n");
  git(base, "add", ".gitignore");
  git(base, "commit", "-m", "chore: ignore gsd runtime");
  // The git action of the closeout fails: the commit hook rejects every commit.
  const hook = join(base, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook rejects the commit' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(base, "work.txt"), "work of the unit\n");

  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.currentUnit = { type: "complete-milestone", id: "M001", startedAt: Date.now() };
  process.chdir(base);

  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
  } as unknown as PostUnitContext["ctx"];
  const result = await postUnitPreVerification({
    s: autoSession,
    ctx,
    pi: {} as PostUnitContext["pi"],
    buildSnapshotOpts: () => ({}),
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto,
    updateProgressWidget: () => {},
  } as PostUnitContext, { skipSettleDelay: true });

  assert.equal(result, "dispatched");
  assert.ok(
    notifications.some((entry) => entry.level === "error" && /^Git commit failed/.test(entry.message)),
    `the failure is shown as an error; got: ${JSON.stringify(notifications)}`,
  );
  const rows = _getAdapter()!.prepare(
    "SELECT blocker_kind FROM auto_pauses WHERE closed_at IS NULL",
  ).all() as Array<{ blocker_kind: string }>;
  assert.deepEqual(rows.map((row) => row.blocker_kind), ["machine_fixable"]);
});

test("postUnitPreVerification blocks on non-transient git action failure", () => {
  const failureBlock = extractSourceRegion(source, 'if (gitResult.status === "failed")');
  // Only transient failures are allowed to warn-and-continue under softFailure.
  assert.ok(failureBlock.includes('if (opts?.softFailure && gitResult.failureClass === "transient")'));
  assert.ok(failureBlock.includes('return "continue"'));
  // Deterministic pre-commit hook rejections on execute-task commits route into bounded remediation retries.
  assert.ok(failureBlock.includes('gitResult.failureClass === "hook-content"'));
  assert.ok(failureBlock.includes('return "retry"'));
  assert.ok(!failureBlock.includes("git-action-failed-nonblocking"));
});

test("buildTaskCommitContextForUnit filters placeholder key_files entries", () => {
  const keyFilesBlock = extractSourceRegion(source, "keyFiles:");
  assert.ok(keyFilesBlock.includes("normalized.length > 0"));
  assert.ok(keyFilesBlock.includes("!normalized.includes(\"{{\")"));
  assert.ok(keyFilesBlock.includes("/^(?:\\(none\\)|none\\.?|n\\/a)$/i.test(normalized)"));
});
