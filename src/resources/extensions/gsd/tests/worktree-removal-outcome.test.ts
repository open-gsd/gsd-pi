// gsd-pi — Worktree removal outcome and live-session detection.
//
// A removal that leaves the directory on disk must not be reported as done,
// and a worktree a running auto-mode session works in must be recognised from
// the session locks. Covers the shared pieces under the removal commands:
// the direct two-ref diff, `removeWorktreeDetailed`, `findLiveWorktreeSession`,
// `/gsd cleanup worktrees`, and the doctor fix for merged worktrees.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { handleWorktree } from "../commands-worktree.ts";
import { handleCleanupWorktrees } from "../commands-maintenance.ts";
import { withCommandCwd } from "../commands/context.ts";
import { checkGitHealth } from "../doctor-git-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { nativeDiffNameStatus } from "../native-git-bridge.ts";
import { acquireSessionLock, releaseSessionLock, updateSessionLock } from "../session-lock.ts";
import { findLiveWorktreeSession } from "../worktree-live-session.ts";
import {
  _setRemoveDirectoryTreeForTests,
  removeWorktree,
  removeWorktreeDetailed,
  worktreeManualCleanupCommand,
  worktreePath,
} from "../worktree-manager.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

// Cleanups of one test run newest first, so a process started inside the
// repository has exited before the repository directory is deleted. Windows
// refuses to delete the working directory of a running process.
const cleanups = new WeakMap<TestContext, Array<() => void | Promise<void>>>();

function onCleanup(t: TestContext, cleanup: () => void | Promise<void>): void {
  let pending = cleanups.get(t);
  if (!pending) {
    const registered: Array<() => void | Promise<void>> = [];
    pending = registered;
    cleanups.set(t, registered);
    t.after(async () => {
      for (const run of registered.reverse()) await run();
    });
  }
  pending.push(cleanup);
}

function makeRepo(t: TestContext): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-worktree-outcome-")));
  onCleanup(t, () => {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  git(base, ["init", "-b", "main"]);
  git(base, ["config", "user.name", "Test User"]);
  git(base, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gitignore"), ".gsd/\n.gsd-worktrees/\n", "utf-8");
  writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "chore: init"]);
  return base;
}

function addMilestoneWorktree(base: string, milestoneId: string): string {
  const wtPath = worktreePath(base, milestoneId);
  mkdirSync(dirname(wtPath), { recursive: true });
  git(base, ["worktree", "add", "-b", `milestone/${milestoneId}`, wtPath]);
  return wtPath;
}

function milestoneWorktree(base: string, milestoneId: string) {
  return { name: milestoneId, path: worktreePath(base, milestoneId), branch: `milestone/${milestoneId}` };
}

/** A process that stays alive until the test ends, started in `cwd`. */
async function startIdleProcess(t: TestContext, cwd: string = tmpdir()): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd,
    stdio: "ignore",
  });
  onCleanup(t, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  await once(child, "spawn");
  return child;
}

/** Pid of a process that has already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const exited = once(child, "exit");
  await exited;
  return child.pid!;
}

function writeLockFile(path: string, pid: number, unitType: string, unitId: string): void {
  const now = new Date().toISOString();
  writeFileSync(path, JSON.stringify({ pid, startedAt: now, unitType, unitId, unitStartedAt: now }), "utf-8");
}

/** Make the directory fallback fail the way a directory in use fails on Windows. */
function refuseDirectoryRemoval(t: TestContext): void {
  _setRemoveDirectoryTreeForTests((dirPath) => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dirPath}'`), { code: "EBUSY" });
  });
  onCleanup(t, () => {
    _setRemoveDirectoryTreeForTests(null);
  });
}

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
}

// ─── Direct two-ref diff ────────────────────────────────────────────────────

test("a direct diff between two refs lists the files that differ", (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  writeFileSync(join(wtPath, "work.txt"), "work\n", "utf-8");
  git(wtPath, ["add", "."]);
  git(wtPath, ["commit", "-m", "feat: work"]);

  const entries = nativeDiffNameStatus(base, "main", "milestone/M007");

  assert.deepEqual(entries, [{ status: "A", path: "work.txt" }]);
});

// ─── Removal outcome ────────────────────────────────────────────────────────

test("a full removal is reported as removed", (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");

  const result = removeWorktreeDetailed(base, "M007", { branch: "milestone/M007" });

  assert.equal(result.status, "removed");
  assert.equal(existsSync(wtPath), false);
  assert.equal(git(base, ["branch", "--list", "milestone/M007"]), "");
});

test("a removal that cannot delete the directory is reported as partial", (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  // A locked worktree makes `git worktree remove --force` refuse, so removal
  // falls through to the directory fallback, which is the step that fails
  // when the directory is in use.
  git(base, ["worktree", "lock", wtPath]);
  refuseDirectoryRemoval(t);

  const result = removeWorktreeDetailed(base, "M007", { branch: "milestone/M007" });

  assert.equal(result.status, "partial");
  assert.equal(existsSync(wtPath), true);
  assert.ok(result.status === "partial" && result.path === realpathSync(wtPath));
  assert.ok(
    result.status === "partial" && result.cleanupCommand === worktreeManualCleanupCommand(realpathSync(wtPath)),
    "the result carries the command that deletes the leftover directory",
  );
  assert.doesNotMatch(git(base, ["worktree", "list"]), /M007/, "git no longer tracks the worktree");
});

test("removeWorktree keeps returning true for a partial removal", (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  git(base, ["worktree", "lock", wtPath]);
  refuseDirectoryRemoval(t);

  assert.equal(removeWorktree(base, "M007", { branch: "milestone/M007" }), true);
});

test(
  "a worktree that is the working directory of another process is partially removed on Windows",
  { skip: process.platform === "win32" ? false : "only Windows refuses to delete a directory that is a process's working directory" },
  async (t) => {
    const base = makeRepo(t);
    const wtPath = addMilestoneWorktree(base, "M007");
    await startIdleProcess(t, wtPath);

    const result = removeWorktreeDetailed(base, "M007", { branch: "milestone/M007" });

    assert.equal(result.status, "partial");
    assert.equal(existsSync(wtPath), true);
    assert.match(
      result.status === "partial" ? result.cleanupCommand ?? "" : "",
      /^Remove-Item -Recurse -Force -LiteralPath '/,
    );
  },
);

test("the manual cleanup command matches the platform's shell", () => {
  assert.equal(
    worktreeManualCleanupCommand("C:\\repo\\.gsd-worktrees\\M007", "win32"),
    "Remove-Item -Recurse -Force -LiteralPath 'C:\\repo\\.gsd-worktrees\\M007'",
  );
  assert.equal(
    worktreeManualCleanupCommand("C:\\it's\\M007", "win32"),
    "Remove-Item -Recurse -Force -LiteralPath 'C:\\it''s\\M007'",
  );
  assert.equal(
    worktreeManualCleanupCommand("/repo/.gsd-worktrees/M007", "linux"),
    'rm -rf "/repo/.gsd-worktrees/M007"',
  );
  assert.equal(
    worktreeManualCleanupCommand("/repo/.gsd-worktrees/M007", "darwin"),
    'rm -rf "/repo/.gsd-worktrees/M007"',
  );
});

test("clean lists a partially removed worktree apart from the removed ones", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  git(base, ["worktree", "lock", wtPath]);
  refuseDirectoryRemoval(t);

  const ctx = createMockCtx();
  await withCommandCwd(base, async () => {
    await handleWorktree("clean", ctx as any);
  });

  const [note] = ctx.notifications;
  assert.equal(note.level, "warning");
  assert.match(note.message, /Cleaned 0 worktrees\./);
  assert.doesNotMatch(note.message, /✓ M007/);
  assert.match(note.message, /Partially removed:\n\s+! M007 \(git no longer tracks it, but the directory could not be deleted: /);
  assert.ok(note.message.includes(worktreeManualCleanupCommand(realpathSync(wtPath))));
});

// ─── Live session detection ─────────────────────────────────────────────────

test("a session lock left by a process that exited is not a live session", async (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");
  writeLockFile(join(base, ".gsd", "auto.lock"), await exitedPid(), "execute-task", "M007/S01/T01");

  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M007")), null);
});

test("the session of this process is found from the lock it holds", (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");
  assert.equal(acquireSessionLock(base).acquired, true);
  onCleanup(t, () => {
    releaseSessionLock(base);
  });
  updateSessionLock(base, "execute-task", "M007/S01/T01");

  assert.deepEqual(findLiveWorktreeSession(base, milestoneWorktree(base, "M007")), {
    pid: process.pid,
    unitType: "execute-task",
    unitId: "M007/S01/T01",
  });
});

test("an unreadable session lock is not a live session", (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");
  writeFileSync(join(base, ".gsd", "auto.lock"), "{ not json", "utf-8");

  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M007")), null);
});

test("a session of another process is attributed to the worktree of its unit's milestone", async (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");
  addMilestoneWorktree(base, "M008");
  const session = await startIdleProcess(t);
  writeLockFile(join(base, ".gsd", "auto.lock"), session.pid!, "plan-slice", "M008/S02");

  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M007")), null);
  assert.deepEqual(findLiveWorktreeSession(base, milestoneWorktree(base, "M008")), {
    pid: session.pid,
    unitType: "plan-slice",
    unitId: "M008/S02",
  });
});

test("a session that has not picked a unit yet keeps milestone worktrees, not manual ones", async (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");
  const session = await startIdleProcess(t);
  writeLockFile(join(base, ".gsd", "auto.lock"), session.pid!, "starting", "bootstrap");

  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M007"))?.pid, session.pid);
  assert.equal(
    findLiveWorktreeSession(base, {
      name: "feature-x",
      path: worktreePath(base, "feature-x"),
      branch: "worktree/feature-x",
    }),
    null,
  );
});

test("a parallel worker's milestone lock marks its worktree as in use", async (t) => {
  const base = makeRepo(t);
  addMilestoneWorktree(base, "M007");
  addMilestoneWorktree(base, "M008");
  const worker = await startIdleProcess(t);
  writeLockFile(join(base, ".gsd", "auto-M007.lock"), worker.pid!, "execute-task", "M007/S01/T02");

  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M007"))?.pid, worker.pid);
  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M008")), null);
});

test("a session lock inside the worktree's own .gsd marks that worktree as in use", async (t) => {
  const base = makeRepo(t);
  const wtPath = addMilestoneWorktree(base, "M007");
  mkdirSync(join(wtPath, ".gsd"), { recursive: true });
  const session = await startIdleProcess(t);
  writeLockFile(join(wtPath, ".gsd", "auto.lock"), session.pid!, "execute-task", "M007/S01/T01");

  assert.equal(findLiveWorktreeSession(base, milestoneWorktree(base, "M007"))?.pid, session.pid);
});

// ─── Other removal surfaces ─────────────────────────────────────────────────

test("/gsd cleanup worktrees keeps a merged worktree a live session works in", async (t) => {
  const base = makeRepo(t);
  const busy = addMilestoneWorktree(base, "M007");
  const idle = addMilestoneWorktree(base, "M008");
  const session = await startIdleProcess(t);
  writeLockFile(join(base, ".gsd", "auto.lock"), session.pid!, "execute-task", "M007/S01/T01");

  const ctx = createMockCtx();
  await handleCleanupWorktrees(ctx as any, base);

  const report = ctx.notifications.map((n) => n.message).join("\n");
  assert.equal(existsSync(busy), true);
  assert.equal(existsSync(idle), false);
  assert.match(report, new RegExp(`⊘ M007 {2}\\(not removed — in use by a running auto-mode session, pid ${session.pid}`));
  assert.match(report, /✓ M008 {2}removed \(branch milestone\/M008 deleted\)/);
  assert.equal(git(base, ["branch", "--list", "milestone/M008"]), "");
});

test("the doctor fix for a merged worktree keeps one a live session works in", async (t) => {
  const base = makeRepo(t);
  const busy = addMilestoneWorktree(base, "M007");
  const idle = addMilestoneWorktree(base, "M008");
  const session = await startIdleProcess(t);
  writeLockFile(join(base, ".gsd", "auto.lock"), session.pid!, "execute-task", "M007/S01/T01");

  const issues: DoctorIssue[] = [];
  const fixesApplied: string[] = [];
  await checkGitHealth(base, issues, fixesApplied, (code) => code === "worktree_branch_merged", "worktree");

  assert.equal(existsSync(busy), true);
  assert.equal(existsSync(idle), false);
  assert.ok(
    fixesApplied.some((fix) =>
      fix.startsWith(`kept merged worktree "M007": in use by a running auto-mode session, pid ${session.pid}`)),
    `fixes: ${JSON.stringify(fixesApplied)}`,
  );
  assert.ok(
    fixesApplied.includes('removed merged worktree "M008" and deleted branch milestone/M008'),
    `fixes: ${JSON.stringify(fixesApplied)}`,
  );
});
