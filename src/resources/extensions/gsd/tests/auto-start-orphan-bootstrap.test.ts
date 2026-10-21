// Project/App: gsd-pi
// File Purpose: Bootstrap behavior tests for completed milestone orphan merges.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapAutoSession } from "../auto-start.ts";
import { AutoSession } from "../auto/session.ts";
import {
  acquireSessionLock,
  isSessionLockHeld,
  releaseSessionLock,
  validateSessionLock,
} from "../session-lock.ts";
import type { InterruptedSessionAssessment } from "../interrupted-session.ts";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";

function runGit(base: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: base,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepoWithUnmergedCompletedMilestone(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-orphan-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"branch\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M002"]);
  writeFileSync(join(base, "m002.txt"), "complete but unmerged\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M002 work"]);
  runGit(base, ["checkout", "main"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Completed milestone", status: "complete" });
  insertMilestone({ id: "M003", title: "Next milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeRepoWithStrandedActiveMilestone(options: { deepPlanning?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-stranded-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    options.deepPlanning
      ? "---\nplanning_depth: deep\ngit:\n  isolation: \"none\"\n---\n"
      : "---\ngit:\n  isolation: \"none\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(base, "m001.txt"), "in-progress stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M001 in progress"]);
  runGit(base, ["checkout", "main"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Active milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeRepoWithMultipleStrandedMilestones(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-multiple-stranded-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"none\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(base, "m001.txt"), "active stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M001 in progress"]);
  runGit(base, ["checkout", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M002"]);
  writeFileSync(join(base, "m002.txt"), "additional stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M002 in progress"]);
  runGit(base, ["checkout", "main"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Active milestone", status: "active" });
  insertMilestone({ id: "M002", title: "Pending milestone", status: "pending" });
  closeDatabase();

  return base;
}

function makeRepoWithOnlySiblingStrandedAndLockedActive(): string {
  // Locked milestone (M002) is the active row but has NO stranded
  // milestone branch. A sibling milestone (M001) has a stranded branch.
  // A parallel worker locked to M002 must skip the sibling's stranded
  // action entirely — neither block on it nor adopt it.
  const base = mkdtempSync(join(tmpdir(), "gsd-locked-no-stranded-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });
  // M002 has CONTEXT so bootstrap's pre-planning gate doesn't route to
  // showSmartEntry and the test reaches the post-lock session-init path.
  writeFileSync(
    join(base, ".gsd", "milestones", "M002", "M002-CONTEXT.md"),
    "# M002 context\n",
  );
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"none\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  // Sibling M001 has stranded work on milestone/M001.
  runGit(base, ["checkout", "-b", "milestone/M001"]);
  writeFileSync(join(base, "m001.txt"), "sibling stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M001 in progress"]);
  runGit(base, ["checkout", "main"]);

  // M002 has no stranded branch at all.
  openDatabase(join(base, ".gsd", "gsd.db"));
  // Both milestones are open so the stranded audit produces a blocking
  // action for the sibling (M001). M002 is the lock target and active
  // row; getActiveMilestoneId honors the lock regardless of M001 order.
  insertMilestone({ id: "M001", title: "Sibling milestone", status: "pending" });
  insertMilestone({ id: "M002", title: "Locked milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeRepoWithActiveMismatchAndStrandedTarget(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-targeted-stranded-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"worktree\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["checkout", "-b", "milestone/M002"]);
  writeFileSync(join(base, "m002.txt"), "target stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M002 in progress"]);
  runGit(base, ["checkout", "main"]);
  runGit(base, ["worktree", "add", ".gsd/worktrees/M002", "milestone/M002"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Incorrect active milestone", status: "active" });
  insertMilestone({ id: "M002", title: "Target stranded milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeRepoWithRecoveredCleanupAndStrandedMismatch(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-stranded-bootstrap-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: \"none\"\n---\n",
  );
  runGit(base, ["init"]);
  runGit(base, ["config", "user.email", "test@test.com"]);
  runGit(base, ["config", "user.name", "Test"]);
  writeFileSync(join(base, "README.md"), "# test\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "init"]);
  runGit(base, ["branch", "-M", "main"]);

  runGit(base, ["branch", "milestone/M001"]);
  runGit(base, ["checkout", "-b", "milestone/M002"]);
  writeFileSync(join(base, "m002.txt"), "in-progress stranded work\n");
  runGit(base, ["add", "-A"]);
  runGit(base, ["commit", "-m", "feat: M002 in progress"]);
  runGit(base, ["checkout", "main"]);

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Completed milestone", status: "complete" });
  insertMilestone({ id: "M002", title: "Stranded milestone", status: "active" });
  closeDatabase();

  return base;
}

function makeCtx(notifications: Array<{ message: string; level?: string }>) {
  const model = { provider: "claude-code", id: "claude-sonnet-4-6", contextWindow: 128000 };
  return {
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      setStatus: () => {},
      setWidget: () => {},
    },
    model,
    modelRegistry: {
      getAvailable: () => [model],
      isProviderRequestReady: () => true,
      getProviderAuthMode: () => "oauth",
    },
    sessionManager: {
      getSessionId: () => "orphan-bootstrap-test",
      getSessionFile: () => null,
      getEntries: () => [],
    },
  };
}

test("fresh bootstrap clears isolation degradation from a prior auto run (#1689)", async () => {
  const s = new AutoSession();
  s.isolationDegraded = true;
  const notifications: Array<{ message: string; level?: string }> = [];

  const ready = await bootstrapAutoSession(
    s,
    makeCtx(notifications) as any,
    {} as any,
    tmpdir(),
    false,
    false,
    {} as any,
    {} as unknown as InterruptedSessionAssessment,
  );

  assert.equal(ready, false, "the system temp root should stop bootstrap at directory validation");
  assert.equal(s.isolationDegraded, false, "fresh bootstrap must not inherit degradation");
});

test("re-entrant bootstrap failure preserves the outer session lock", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-reentrant-bootstrap-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const previousProjectId = process.env.GSD_PROJECT_ID;
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    assert.deepEqual(acquireSessionLock(base), { acquired: true });
    process.env.GSD_PROJECT_ID = "invalid project id";

    const ready = await bootstrapAutoSession(
      new AutoSession(),
      makeCtx(notifications) as any,
      { getThinkingLevel: () => "medium" } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({} as any),
      },
      {} as InterruptedSessionAssessment,
    );

    assert.equal(ready, false);
    assert.match(notifications.at(-1)?.message ?? "", /GSD_PROJECT_ID/);
    assert.equal(
      isSessionLockHeld(base),
      true,
      "failed inner bootstrap must not release outer ownership",
    );
    assert.equal(
      validateSessionLock(base),
      true,
      "outer lock remains valid after inner bootstrap aborts",
    );
  } finally {
    if (previousProjectId === undefined) delete process.env.GSD_PROJECT_ID;
    else process.env.GSD_PROJECT_ID = previousProjectId;
    releaseSessionLock(base);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap aborts before starting next milestone when completed orphan merge fails", async () => {
  const base = makeRepoWithUnmergedCompletedMilestone();
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const mergeCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => true,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          exitMilestone: (milestoneId: string) => {
            mergeCalls.push(milestoneId);
            return {
              ok: false,
              reason: "teardown-failed",
              cause: new Error("synthetic merge failure"),
            };
          },
          enterMilestone: () => ({ ok: true, mode: "none", path: base }),
          // ADR-016 phase 2 / B4 (#5622): the orphan-merge dance now goes
          // through `adoptOrphanWorktree`. The mock invokes the callback
          // and returns its result without exercising the swap-revert
          // protocol — this test only cares about the merge call being
          // recorded and the bootstrap returning `false` on failure.
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    assert.equal(ready, false);
    assert.deepEqual(mergeCalls, ["M002"]);
    assert.equal(s.active, false);
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /Could not merge orphan milestone M002: synthetic merge failure/,
    );
  } finally {
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("headless bootstrap checks stranded work before recovered-complete shortcut", async () => {
  const base = makeRepoWithRecoveredCleanupAndStrandedMismatch();
  const previousCwd = process.cwd();
  const previousHeadless = process.env.GSD_HEADLESS;
  const previousParallelWorker = process.env.GSD_PARALLEL_WORKER;
  const previousMilestoneLock = process.env.GSD_MILESTONE_LOCK;
  const s = new AutoSession();
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    process.env.GSD_HEADLESS = "1";
    process.env.GSD_PARALLEL_WORKER = "1";
    process.env.GSD_MILESTONE_LOCK = "M001";

    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: () => ({ ok: true, mode: "none", path: base }),
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.equal(ready, false);
    assert.match(messages, /Stranded work for M002 blocks auto-mode/);
    assert.match(messages, /\/gsd auto M002/);
    assert.match(messages, /\/gsd park M002 "reason"/);
    assert.match(messages, /\/gsd rethink/);
    assert.doesNotMatch(messages, /all milestones complete/);
  } finally {
    if (previousHeadless === undefined) {
      delete process.env.GSD_HEADLESS;
    } else {
      process.env.GSD_HEADLESS = previousHeadless;
    }
    if (previousParallelWorker === undefined) {
      delete process.env.GSD_PARALLEL_WORKER;
    } else {
      process.env.GSD_PARALLEL_WORKER = previousParallelWorker;
    }
    if (previousMilestoneLock === undefined) {
      delete process.env.GSD_MILESTONE_LOCK;
    } else {
      process.env.GSD_MILESTONE_LOCK = previousMilestoneLock;
    }
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap blocks active stranded recovery when another open milestone also has stranded work", async () => {
  const base = makeRepoWithMultipleStrandedMilestones();
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const adoptCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: () => ({ ok: true, mode: "none", path: base }),
          adoptStrandedMilestone: (milestoneId: string) => {
            adoptCalls.push(milestoneId);
            return { ok: true, mode: "branch", path: base };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.equal(ready, false);
    assert.deepEqual(adoptCalls, []);
    assert.match(messages, /Stranded work for M002 blocks auto-mode before M001/);
    assert.match(messages, /\/gsd auto M002/);
    assert.match(messages, /\/gsd park M002 "reason"/);
    assert.match(messages, /explicitly discard M002/);
  } finally {
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("parallel worker recovers its locked stranded milestone despite stranded siblings", async () => {
  const base = makeRepoWithMultipleStrandedMilestones();
  const previousCwd = process.cwd();
  const previousLock = process.env.GSD_MILESTONE_LOCK;
  const previousWorker = process.env.GSD_PARALLEL_WORKER;
  const s = new AutoSession();
  const adoptCalls: Array<{ milestoneId: string; mode: string }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    process.env.GSD_PARALLEL_WORKER = "1";
    process.env.GSD_MILESTONE_LOCK = "M002";

    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: () => ({ ok: true, mode: "none", path: base }),
          adoptStrandedMilestone: (
            milestoneId: string,
            sessionBase: string,
            _ctx: unknown,
            opts: { mode: "worktree" | "branch" },
          ) => {
            adoptCalls.push({ milestoneId, mode: opts.mode });
            s.basePath = sessionBase;
            s.originalBasePath = sessionBase;
            s.strandedRecoveryIsolationMode = opts.mode;
            return { ok: true, mode: opts.mode, path: sessionBase };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.equal(ready, true);
    assert.deepEqual(adoptCalls, [{ milestoneId: "M002", mode: "branch" }]);
    assert.equal(s.currentMilestoneId, "M002");
    assert.match(messages, /Resuming saved milestone work for M002/);
    assert.doesNotMatch(messages, /blocks auto-mode before M002/);
    assert.doesNotMatch(messages, /\/gsd auto M001/);
  } finally {
    if (previousLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
    else process.env.GSD_MILESTONE_LOCK = previousLock;
    if (previousWorker === undefined) delete process.env.GSD_PARALLEL_WORKER;
    else process.env.GSD_PARALLEL_WORKER = previousWorker;
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("locked worker with no own stranded action does not adopt sibling stranded action", async () => {
  const base = makeRepoWithOnlySiblingStrandedAndLockedActive();
  const previousCwd = process.cwd();
  const previousLock = process.env.GSD_MILESTONE_LOCK;
  const previousWorker = process.env.GSD_PARALLEL_WORKER;
  const s = new AutoSession();
  const adoptCalls: Array<{ milestoneId: string; mode: string }> = [];
  const enterCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    process.env.GSD_PARALLEL_WORKER = "1";
    process.env.GSD_MILESTONE_LOCK = "M002";

    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: (mid: string) => {
            enterCalls.push(mid);
            return { ok: true, mode: "none", path: base };
          },
          adoptStrandedMilestone: (
            milestoneId: string,
            sessionBase: string,
            _ctx: unknown,
            opts: { mode: "worktree" | "branch" },
          ) => {
            adoptCalls.push({ milestoneId, mode: opts.mode });
            s.basePath = sessionBase;
            s.originalBasePath = sessionBase;
            s.strandedRecoveryIsolationMode = opts.mode;
            return { ok: true, mode: opts.mode, path: sessionBase };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.equal(ready, true);
    // Must not adopt M001 (the sibling stranded action) — the locked
    // worker has no stranded action of its own, so adoption should not
    // run at all. enterMilestone for M002 is also gated off by
    // isolation=none with no stranded recoveryMode (#742 regression).
    assert.deepEqual(adoptCalls, []);
    assert.equal(s.currentMilestoneId, "M002");
    assert.doesNotMatch(messages, /Resuming saved milestone work for M001/);
    assert.doesNotMatch(messages, /blocks auto-mode before M002/);
  } finally {
    if (previousLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
    else process.env.GSD_MILESTONE_LOCK = previousLock;
    if (previousWorker === undefined) delete process.env.GSD_PARALLEL_WORKER;
    else process.env.GSD_PARALLEL_WORKER = previousWorker;
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap honors explicit solo milestone lock when recovering stranded target worktree", async () => {
  const base = makeRepoWithActiveMismatchAndStrandedTarget();
  const previousCwd = process.cwd();
  const previousLock = process.env.GSD_MILESTONE_LOCK;
  const previousWorker = process.env.GSD_PARALLEL_WORKER;
  const s = new AutoSession();
  const adoptCalls: Array<{ milestoneId: string; mode: string }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    delete process.env.GSD_PARALLEL_WORKER;
    process.env.GSD_MILESTONE_LOCK = "M002";

    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: () => ({ ok: true, mode: "worktree", path: base }),
          adoptStrandedMilestone: (
            milestoneId: string,
            sessionBase: string,
            _ctx: unknown,
            opts: { mode: "worktree" | "branch" },
          ) => {
            adoptCalls.push({ milestoneId, mode: opts.mode });
            s.basePath = sessionBase;
            s.originalBasePath = sessionBase;
            s.strandedRecoveryIsolationMode = opts.mode;
            return { ok: true, mode: opts.mode, path: sessionBase };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.equal(ready, true);
    assert.deepEqual(adoptCalls, [{ milestoneId: "M002", mode: "worktree" }]);
    assert.equal(s.currentMilestoneId, "M002");
    assert.match(messages, /Resuming saved milestone work for M002/);
    assert.doesNotMatch(messages, /blocks auto-mode before M001/);
    assert.doesNotMatch(messages, /Stranded work for in-progress milestone M002/);
    assert.ok(
      notifications.some((entry) => entry.level === "info" && entry.message.includes("Resuming saved milestone work for M002")),
      "active recovery should be presented as an info-level resume",
    );
  } finally {
    if (previousLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
    else process.env.GSD_MILESTONE_LOCK = previousLock;
    if (previousWorker === undefined) delete process.env.GSD_PARALLEL_WORKER;
    else process.env.GSD_PARALLEL_WORKER = previousWorker;
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap adopts stranded active branch even when isolation is none", async () => {
  const base = makeRepoWithStrandedActiveMilestone();
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const adoptCalls: Array<{ milestoneId: string; mode: string }> = [];
  const enterCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: (milestoneId: string) => {
            enterCalls.push(milestoneId);
            return { ok: true, mode: "none", path: base };
          },
          adoptStrandedMilestone: (
            milestoneId: string,
            sessionBase: string,
            _ctx: unknown,
            opts: { mode: "worktree" | "branch" },
          ) => {
            adoptCalls.push({ milestoneId, mode: opts.mode });
            s.basePath = sessionBase;
            s.originalBasePath = sessionBase;
            s.strandedRecoveryIsolationMode = opts.mode;
            return { ok: true, mode: opts.mode, path: sessionBase };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    assert.equal(ready, true);
    assert.deepEqual(adoptCalls, [{ milestoneId: "M001", mode: "branch" }]);
    assert.deepEqual(enterCalls, []);
    assert.equal(s.currentMilestoneId, "M001");
    assert.equal(s.strandedRecoveryIsolationMode, "branch");
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /Resuming saved milestone work for M001/,
    );
    assert.ok(
      notifications.every((entry) => entry.level !== "warning" || !entry.message.includes("Stranded work for in-progress milestone M001")),
      "adopting the active milestone should not emit a scary stranded-work warning",
    );
  } finally {
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap adopts stranded active branch before deep project setup", async () => {
  const base = makeRepoWithStrandedActiveMilestone({ deepPlanning: true });
  const previousCwd = process.cwd();
  const s = new AutoSession();
  const adoptCalls: Array<{ milestoneId: string; mode: string }> = [];
  const enterCalls: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];

  try {
    const ready = await bootstrapAutoSession(
      s,
      makeCtx(notifications) as any,
      {
        getThinkingLevel: () => "medium",
        getActiveTools: () => [],
        events: { emit: () => {} },
      } as any,
      base,
      false,
      false,
      {
        shouldUseWorktreeIsolation: () => false,
        registerSigtermHandler: () => {},
        registerAutoWorkerForSession: () => {},
        lockBase: () => base,
        buildLifecycle: () => ({
          adoptSessionRoot: (sessionBase: string, originalBase?: string) => {
            s.basePath = sessionBase;
            if (originalBase !== undefined) {
              s.originalBasePath = originalBase;
            } else if (!s.originalBasePath) {
              s.originalBasePath = sessionBase;
            }
          },
          enterMilestone: (milestoneId: string) => {
            enterCalls.push(milestoneId);
            return { ok: true, mode: "none", path: base };
          },
          adoptStrandedMilestone: (
            milestoneId: string,
            sessionBase: string,
            _ctx: unknown,
            opts: { mode: "worktree" | "branch" },
          ) => {
            adoptCalls.push({ milestoneId, mode: opts.mode });
            s.basePath = sessionBase;
            s.originalBasePath = sessionBase;
            s.strandedRecoveryIsolationMode = opts.mode;
            return { ok: true, mode: opts.mode, path: sessionBase };
          },
          adoptOrphanWorktree: <T extends { merged: boolean }>(
            _mid: string,
            _base: string,
            run: () => T,
          ): T => run(),
        }) as any,
      },
      {
        classification: "none",
        lock: null,
        pausedSession: null,
        state: null,
        recovery: null,
        recoveryPrompt: null,
        recoveryToolCallCount: 0,
        artifactSatisfied: false,
        hasResumableDiskState: false,
        isBootstrapCrash: false,
      },
    );

    assert.equal(ready, true);
    assert.deepEqual(adoptCalls, [{ milestoneId: "M001", mode: "branch" }]);
    assert.deepEqual(enterCalls, []);
    assert.equal(s.currentMilestoneId, "M001");
    assert.equal(s.strandedRecoveryIsolationMode, "branch");
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /Resuming saved milestone work for M001/,
    );
    assert.ok(
      notifications.every((entry) => entry.level !== "warning" || !entry.message.includes("Stranded work for in-progress milestone M001")),
      "adopting the active milestone should not emit a scary stranded-work warning",
    );
  } finally {
    try {
      closeDatabase();
    } catch {}
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
