// Project/App: gsd-pi
// File Purpose: Behavior tests for auto-loop cleanup after paused provider exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  anchorProcessCwdForAutoResume,
  _restorePausedPreExecRepairStateForTest,
  cleanupAfterLoopExit,
  maybeRerootStepSessionForHighContext,
  pauseAuto,
  rerootCommandSession,
  stopAuto,
} from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { getAutoWorker, registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease, getMilestoneLease } from "../db/milestone-leases.ts";
import { readPausedSessionMetadata } from "../interrupted-session.ts";
import { WorktreeLifecycle } from "../worktree-lifecycle.ts";

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function renderOutcomeWidget(widget: unknown): string {
  const component = (widget as any)(
    { requestRender() {} },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
  );
  return component.render(100).join("\n");
}

test("cleanupAfterLoopExit preserves paused auto badge after provider pause", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-cleanup-"));
  const previousCwd = process.cwd();
  const statuses: Array<[string, string | undefined]> = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = true;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M001");
  autoSession.originalBasePath = base;

  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: (key: string, value: string | undefined) => {
          statuses.push([key, value]);
        },
        setWidget: () => {},
        notify: () => {},
      },
    } as any);

    assert.equal(statuses.some(([key]) => key === "gsd-auto"), false);
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, true);
  } finally {
    closeDatabase();
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit preserves paused worktree session and visible failure output", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-session-preserve-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  const newSessionWorkspaces: string[] = [];
  let restoreCalls = 0;

  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function () {
    restoreCalls += 1;
  });

  mkdirSync(worktree, { recursive: true });
  process.chdir(worktree);
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;
  autoSession.cmdCtx = {
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      return { cancelled: false };
    },
  } as any;

  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        notify: () => {},
      },
    } as any);

    assert.equal(restoreCalls, 0, "paused cleanup must not restore out of the active worktree");
    assert.deepEqual(newSessionWorkspaces, [], "paused cleanup must not start a blank rerooted session");
    assert.equal(autoSession.basePath, worktree);
    assert.equal(realpathSync(process.cwd()), realpathSync(worktree));
    assert.equal(autoSession.paused, true);
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("anchorProcessCwdForAutoResume recovers when current cwd was deleted", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-resume-cwd-anchor-"));
  const deletedCwd = join(base, ".gsd-worktrees", "M002");
  const previousCwd = process.cwd();

  mkdirSync(deletedCwd, { recursive: true });

  try {
    process.chdir(deletedCwd);
    rmSync(deletedCwd, { recursive: true, force: true });

    assert.equal(anchorProcessCwdForAutoResume(base), true);
    assert.equal(realpathSync(process.cwd()), realpathSync(base));
  } finally {
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("anchorProcessCwdForAutoResume falls back when primary basePath is missing", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-resume-cwd-anchor-fallback-"));
  const missingWorktree = join(base, ".gsd-worktrees", "M002");
  const previousCwd = process.cwd();

  mkdirSync(base, { recursive: true });
  mkdirSync(dirname(missingWorktree), { recursive: true });

  try {
    assert.equal(anchorProcessCwdForAutoResume(missingWorktree, [base]), true);
    assert.equal(realpathSync(process.cwd()), realpathSync(base));
  } finally {
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit clears status and progress widget without replacing outcome surface", async () => {
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;

  try {
    await cleanupAfterLoopExit({
      hasUI: false,
      ui: {
        setStatus: (...args: unknown[]) => statusCalls.push(args),
        setWidget: (...args: unknown[]) => widgetCalls.push(args),
        notify: () => {},
      },
    } as any);

    assert.deepEqual(statusCalls, [["gsd-auto", undefined]]);
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-progress" && args[1] === undefined),
      true,
      "cleanup must clear the stale auto progress widget",
    );
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-outcome"),
      false,
      "cleanup must not replace the auto deck with a generic loop-ended card",
    );
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, false);
  } finally {
    autoSession.reset();
  }
});

test("cleanupAfterLoopExit preserves completion closeout surface after stopAuto reset", async () => {
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.completionStopInProgress = true;
  autoSession.resetAfterStop({ preserveCompletionSurface: true });

  try {
    await cleanupAfterLoopExit({
      hasUI: true,
      ui: {
        setStatus: (...args: unknown[]) => statusCalls.push(args),
        setWidget: (...args: unknown[]) => widgetCalls.push(args),
        setHeader: () => {},
        notify: () => {},
      },
    } as any);

    assert.deepEqual(statusCalls, [["gsd-auto", undefined]]);
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-progress" && args[1] === undefined),
      false,
      "post-loop completion cleanup must not clear the foreground closeout surface",
    );
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-outcome"),
      false,
      "completion cleanup must not replace the closeout surface with a generic outcome card",
    );
    assert.equal(
      autoSession.completionStopInProgress,
      true,
      "completion closeout preservation must survive post-loop cleanup until the next agent turn",
    );
  } finally {
    autoSession.reset();
  }
});

test("cleanupAfterLoopExit preserves completionStopInProgress even when preserveStepSurfaceAfterLoopExit is also set", async () => {
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.completionStopInProgress = true;
  autoSession.preserveStepSurfaceAfterLoopExit = true;

  try {
    await cleanupAfterLoopExit({
      hasUI: true,
      ui: {
        setStatus: (...args: unknown[]) => statusCalls.push(args),
        setWidget: (...args: unknown[]) => widgetCalls.push(args),
        setHeader: () => {},
        notify: () => {},
      },
    } as any);

    assert.equal(
      autoSession.completionStopInProgress,
      true,
      "completionStopInProgress must survive cleanup even when preserveStepSurfaceAfterLoopExit was also set",
    );
    assert.equal(autoSession.preserveStepSurfaceAfterLoopExit, false);
  } finally {
    autoSession.reset();
  }
});

test("pauseAuto preserves artifact retry counts across pause/resume", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-pause-retry-count-"));
  const previousCwd = process.cwd();
  const retryKey = "execute-task:M001/S01/T01";

  autoSession.reset();
  autoSession.active = true;
  autoSession.verificationRetryCount.set(retryKey, 2);
  autoSession.pendingVerificationRetry = {
    unitId: "M001/S01/T01",
    failureContext: "Missing expected artifact (attempt 2/3).",
    attempt: 2,
  };

  try {
    process.chdir(base);
    await pauseAuto();

    assert.equal(autoSession.paused, true);
    assert.equal(autoSession.pendingVerificationRetry, null);
    assert.equal(autoSession.verificationRetryCount.get(retryKey), 2);
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("pauseAuto persists and restores pre-exec repair context", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-pause-pre-exec-context-"));
  const previousCwd = process.cwd();
  mkdirSync(join(base, ".gsd"), { recursive: true });

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";
  autoSession.lastPreExecFailure = {
    unitId: "M001/S01",
    blockingFindings: ["T01 Verify command uses a pipe"],
    verdictExcerpt: "status=fail; 1 blocking issue detected",
  };
  autoSession.preExecRetryCount.set("M001/S01", 2);

  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    process.chdir(base);
    await pauseAuto();

    const meta = readPausedSessionMetadata(base);
    assert.deepEqual(meta?.lastPreExecFailure, autoSession.lastPreExecFailure);
    assert.deepEqual(meta?.preExecRetryCount, { "M001/S01": 2 });

    autoSession.lastPreExecFailure = null;
    autoSession.preExecRetryCount.clear();
    _restorePausedPreExecRepairStateForTest(meta!, autoSession);

    const restoredFailure = autoSession.lastPreExecFailure as {
      unitId: string;
      blockingFindings: string[];
    } | null;
    assert.equal(restoredFailure?.unitId, "M001/S01");
    assert.deepEqual(restoredFailure?.blockingFindings, ["T01 Verify command uses a pipe"]);
    assert.equal(autoSession.preExecRetryCount.get("M001/S01"), 2);
  } finally {
    closeDatabase();
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("pauseAuto marks active worker as stopping and clears workerId", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-pause-worker-stop-"));
  const previousCwd = process.cwd();
  const dbPath = join(base, ".gsd", "gsd.db");
  mkdirSync(join(base, ".gsd"), { recursive: true });

  autoSession.reset();
  autoSession.active = true;

  try {
    openDatabase(dbPath);
    const workerId = registerAutoWorker({ projectRootRealpath: base });
    autoSession.workerId = workerId;
    process.chdir(base);

    await pauseAuto();

    assert.equal(autoSession.workerId, null);
    assert.equal(getAutoWorker(workerId)?.status, "stopping");
  } finally {
    autoSession.reset();
    try {
      closeDatabase();
    } catch {
      /* noop */
    }
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("pauseAuto preserves worker lease across transient provider auto-resume pauses", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-pause-provider-lease-"));
  const previousCwd = process.cwd();
  const dbPath = join(base, ".gsd", "gsd.db");
  mkdirSync(join(base, ".gsd"), { recursive: true });

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M001";

  try {
    openDatabase(dbPath);
    insertMilestone({ id: "M001", title: "Milestone 1", status: "active" });
    const workerId = registerAutoWorker({ projectRootRealpath: base });
    const lease = claimMilestoneLease(workerId, "M001");
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    autoSession.workerId = workerId;
    autoSession.milestoneLeaseToken = lease.token;
    process.chdir(base);

    await pauseAuto(undefined, undefined, {
      message: "Provider error: socket closed",
      category: "provider",
      isTransient: true,
    });

    assert.equal(autoSession.paused, true);
    assert.equal(autoSession.workerId, workerId);
    assert.equal(autoSession.milestoneLeaseToken, lease.token);
    assert.equal(getAutoWorker(workerId)?.status, "active");
    const row = getMilestoneLease("M001");
    assert.equal(row?.worker_id, workerId);
    assert.equal(row?.status, "held");
    assert.equal(row?.fencing_token, lease.token);
  } finally {
    autoSession.reset();
    try {
      closeDatabase();
    } catch {
      /* noop */
    }
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("pauseAuto records the expected worktree path when paused from project root", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-pause-worktree-path-"));
  const previousCwd = process.cwd();

  autoSession.reset();
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      "---\nversion: 1\ngit:\n  isolation: worktree\n---\n",
      "utf-8",
    );
    runGit(["init", "-b", "main"], base);
    runGit(["config", "user.name", "Test User"], base);
    runGit(["config", "user.email", "test@example.com"], base);
    writeFileSync(join(base, "README.md"), "# Test Project\n", "utf-8");
    runGit(["add", "."], base);
    runGit(["commit", "-m", "chore: init"], base);
    openDatabase(join(base, ".gsd", "gsd.db"));
    process.chdir(base);

    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.originalBasePath = base;
    autoSession.currentMilestoneId = "M001";

    await pauseAuto();

    const meta = readPausedSessionMetadata(base);
    assert.ok(meta);
    // No worktree exists yet, so the recorded path is the canonical
    // .gsd-worktrees/ creation location (worktree-placement seam).
    assert.equal(meta.worktreePath, join(base, ".gsd-worktrees", "M001"));
  } finally {
    autoSession.reset();
    try {
      closeDatabase();
    } catch {
      /* noop */
    }
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit preserves step-mode surface and worktree session after completed step", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-step-surface-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  const statusCalls: unknown[] = [];
  const widgetCalls: unknown[] = [];
  const newSessionWorkspaces: string[] = [];
  let restoreCalls = 0;

  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function () {
    restoreCalls += 1;
  });

  mkdirSync(worktree, { recursive: true });
  process.chdir(worktree);
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.stepMode = true;
  autoSession.preserveStepSurfaceAfterLoopExit = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;
  autoSession.cmdCtx = {
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      return { cancelled: false };
    },
  } as any;

  try {
    await cleanupAfterLoopExit({
      hasUI: true,
      ui: {
        setStatus: (...args: unknown[]) => statusCalls.push(args),
        setWidget: (...args: unknown[]) => widgetCalls.push(args),
        setHeader: () => {},
        notify: () => {},
      },
    } as any);

    assert.deepEqual(statusCalls, [], "step-mode cleanup must leave the NEXT badge visible");
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-progress" && args[1] === undefined),
      false,
      "step-mode cleanup must not clear the completed step progress surface",
    );
    assert.equal(
      widgetCalls.some((args) => Array.isArray(args) && args[0] === "gsd-health"),
      false,
      "step-mode cleanup must not replace the progress surface with idle health",
    );
    assert.deepEqual(newSessionWorkspaces, [], "step-mode cleanup must not re-root when context is below threshold");
    assert.equal(restoreCalls, 0, "step-mode cleanup must not restore out of the active worktree");
    assert.equal(autoSession.active, false);
    assert.equal(autoSession.preserveStepSurfaceAfterLoopExit, false);
    assert.equal(autoSession.basePath, worktree);
    assert.equal(realpathSync(process.cwd()), realpathSync(worktree));
  } finally {
    closeDatabase();
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit warns but does not re-root step-mode session at soft compaction threshold", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-step-soft-context-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  const newSessionWorkspaces: string[] = [];
  const notifyMessages: string[] = [];

  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function () {});

  mkdirSync(worktree, { recursive: true });
  process.chdir(worktree);
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.stepMode = true;
  autoSession.preserveStepSurfaceAfterLoopExit = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;
  autoSession.cmdCtx = {
    getContextUsage: () => ({ percent: 72, tokens: 720_000, contextWindow: 1_000_000 }),
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      return { cancelled: false };
    },
  } as any;

  try {
    await cleanupAfterLoopExit({
      hasUI: true,
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        setHeader: () => {},
        notify: (_msg: string) => notifyMessages.push(_msg),
      },
    } as any);

    assert.deepEqual(newSessionWorkspaces, [], "soft context pressure must not force a new command session");
    assert.equal(
      notifyMessages.some((msg) => msg.includes("context at 72.0%") && msg.includes("Use /compact")),
      true,
      "soft threshold should warn with a non-disruptive compaction prompt",
    );
    assert.equal(autoSession.basePath, worktree);
    assert.equal(realpathSync(process.cwd()), realpathSync(worktree));
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit re-roots step-mode session at hard context threshold", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-step-reroot-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  const newSessionWorkspaces: string[] = [];
  const notifyMessages: string[] = [];

  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function () {});

  mkdirSync(worktree, { recursive: true });
  process.chdir(worktree);
  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.stepMode = true;
  autoSession.preserveStepSurfaceAfterLoopExit = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;
  autoSession.cmdCtx = {
    getContextUsage: () => ({ percent: 92, tokens: 920_000, contextWindow: 1_000_000 }),
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      return { cancelled: false };
    },
  } as any;

  try {
    await cleanupAfterLoopExit({
      hasUI: true,
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        setHeader: () => {},
        notify: (_msg: string) => notifyMessages.push(_msg),
      },
    } as any);

    assert.deepEqual(newSessionWorkspaces, [worktree], "critical context pressure should re-root in the active worktree");
    assert.equal(
      notifyMessages.some((msg) => msg.includes("Fresh session ready for /gsd next")),
      true,
      "step-mode reroot should notify the user",
    );
    assert.equal(autoSession.basePath, worktree);
    assert.equal(realpathSync(process.cwd()), realpathSync(worktree));
  } finally {
    closeDatabase();
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("maybeRerootStepSessionForHighContext re-roots at the hard threshold even when the soft pref is set above it", async () => {
  // Regression: the hard 90% re-root must not be gated behind the configurable
  // soft warn threshold, which is allowed up to 0.95. At 92% usage with a 0.95
  // soft pref the soft warn predicate is false, but the session must still
  // re-root because usage crossed the fixed hard boundary.
  const dir = mkdtempSync(join(tmpdir(), "gsd-hard-reroot-high-soft-"));
  const project = join(dir, "project");
  const gsdHomeDir = join(dir, "home");
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;

  mkdirSync(join(project, ".gsd"), { recursive: true });
  mkdirSync(gsdHomeDir, { recursive: true });
  writeFileSync(
    join(project, ".gsd", "PREFERENCES.md"),
    ["---", "version: 1", "context_management:", "  compaction_threshold_percent: 0.95", "---", ""].join("\n"),
    "utf-8",
  );

  process.env.GSD_HOME = gsdHomeDir;
  process.chdir(project);

  const newSessionWorkspaces: string[] = [];
  const notifyMessages: string[] = [];
  const cmdCtx = {
    getContextUsage: () => ({ percent: 92, tokens: 920_000, contextWindow: 1_000_000 }),
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      return { cancelled: false };
    },
  } as any;
  const ctx = { ui: { notify: (msg: string) => notifyMessages.push(msg) } } as any;

  try {
    const result = await maybeRerootStepSessionForHighContext(ctx, project, cmdCtx, project);

    assert.equal(result.rerooted, true, "92% usage must re-root even when the soft pref is 95%");
    assert.deepEqual(newSessionWorkspaces, [project], "hard context pressure must re-root the command session");
    const rerootMessage = notifyMessages.find((msg) => msg.includes("Fresh session ready for /gsd next"));
    assert.ok(rerootMessage, "hard re-root should notify the user");
    // The re-root was triggered by the 90% hard limit, so the notification must
    // cite that limit and not the configured 95% soft compaction threshold.
    assert.match(
      rerootMessage,
      /hard threshold: 90%/,
      "hard re-root notification must cite the 90% hard threshold",
    );
    assert.equal(
      rerootMessage.includes("95%"),
      false,
      "hard re-root notification must not cite the configured soft compaction threshold",
    );
  } finally {
    closeDatabase();
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeRerootStepSessionForHighContext writes a compaction snapshot only at the hard boundary", async () => {
  // Regression: the snapshot is reserved for the hard re-root. Soft-only
  // pressure must warn without writing a compaction snapshot.
  const dir = mkdtempSync(join(tmpdir(), "gsd-soft-no-snapshot-"));
  const project = join(dir, "project");
  const gsdHomeDir = join(dir, "home");
  const previousCwd = process.cwd();
  const previousGsdHome = process.env.GSD_HOME;

  mkdirSync(join(project, ".gsd"), { recursive: true });
  mkdirSync(gsdHomeDir, { recursive: true });
  writeFileSync(
    join(project, ".gsd", "PREFERENCES.md"),
    ["---", "version: 1", "context_management:", "  compaction_threshold_percent: 0.6", "---", ""].join("\n"),
    "utf-8",
  );

  process.env.GSD_HOME = gsdHomeDir;
  process.chdir(project);

  const newSessionWorkspaces: string[] = [];
  const notifyMessages: string[] = [];
  let contextPercent = 72;
  const cmdCtx = {
    getContextUsage: () => ({ percent: contextPercent, tokens: contextPercent * 10_000, contextWindow: 1_000_000 }),
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      return { cancelled: false };
    },
  } as any;
  const ctx = { ui: { notify: (msg: string) => notifyMessages.push(msg) } } as any;
  const snapshotPath = join(project, ".gsd", "last-snapshot.md");

  try {
    const softResult = await maybeRerootStepSessionForHighContext(ctx, project, cmdCtx, project);
    assert.equal(softResult.rerooted, false, "soft pressure must not re-root");
    assert.deepEqual(newSessionWorkspaces, [], "soft pressure must not open a new session");
    assert.equal(
      existsSync(snapshotPath),
      false,
      "soft-only pressure must not write a compaction snapshot",
    );
    assert.equal(
      notifyMessages.some((msg) => msg.includes("context at 72.0%") && msg.includes("Use /compact")),
      true,
      "soft threshold should warn with a non-disruptive compaction prompt",
    );

    contextPercent = 92;
    const hardResult = await maybeRerootStepSessionForHighContext(ctx, project, cmdCtx, project);
    assert.equal(hardResult.rerooted, true, "hard pressure must re-root");
    assert.deepEqual(newSessionWorkspaces, [project], "hard pressure should re-root once");
    assert.equal(
      existsSync(snapshotPath),
      true,
      "hard boundary must write the compaction snapshot",
    );
  } finally {
    closeDatabase();
    process.chdir(previousCwd);
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit restores project root through lifecycle and preserves chdir", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-cleanup-lifecycle-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  let restoreCalls = 0;
  const originalRestore = WorktreeLifecycle.prototype.restoreToProjectRoot;
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function (this: WorktreeLifecycle) {
    restoreCalls += 1;
    return originalRestore.call(this);
  });

  mkdirSync(worktree, { recursive: true });
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;

  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        notify: () => {},
      },
    } as any);

    assert.equal(restoreCalls, 1);
    assert.equal(autoSession.basePath, base);
    assert.equal(realpathSync(process.cwd()), realpathSync(base));
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupAfterLoopExit keeps cleanup best-effort when lifecycle restore throws", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-cleanup-restore-throw-"));
  const worktree = join(base, ".gsd", "worktrees", "M001");
  const previousCwd = process.cwd();
  let restoreCalls = 0;
  // ADR-016 phase 3 (#5693): the real `restoreToProjectRoot` assigns
  // `s.basePath = s.originalBasePath` AND chdir's BEFORE any throwable work
  // (rebuildGitService, cache invalidation). Mirror that ordering in the
  // mock so the throw scenario reflects production: basePath and cwd are
  // restored even when the verb throws partway through.
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function (this: WorktreeLifecycle) {
    restoreCalls += 1;
    const sRef = this as unknown as { s: { basePath: string; originalBasePath: string } };
    sRef.s.basePath = sRef.s.originalBasePath;
    try { process.chdir(sRef.s.basePath); } catch { /* mirror real verb's best-effort */ }
    throw new Error("restore failed");
  });

  mkdirSync(worktree, { recursive: true });
  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = worktree;
  autoSession.originalBasePath = base;

  try {
    await cleanupAfterLoopExit({
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        notify: () => {},
      },
    } as any);

    assert.equal(restoreCalls, 1);
    assert.equal(autoSession.basePath, base);
    assert.equal(realpathSync(process.cwd()), realpathSync(base));
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("rerootCommandSession refreshes command workspace to project root", async () => {
  const calls: string[] = [];
  const result = await rerootCommandSession(
    {
      newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
        calls.push(workspaceRoot);
        return { cancelled: false };
      },
    } as any,
    "/project/root",
  );

  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(calls, ["/project/root"]);
});

test("stopAuto foreground completion closeout reroots session and preserves the transcript surface", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-completion-stop-"));
  runGit(["init"], base);
  const previousCwd = process.cwd();
  const widgetCalls: Array<[string, unknown]> = [];
  const notifications: string[] = [];
  const newSessionWorkspaces: string[] = [];
  let restoreCalls = 0;
  const originalRestore = WorktreeLifecycle.prototype.restoreToProjectRoot;
  t.mock.method(WorktreeLifecycle.prototype, "restoreToProjectRoot", function (this: WorktreeLifecycle) {
    restoreCalls += 1;
    return originalRestore.call(this);
  });
  const milestoneDir = join(base, ".gsd", "milestones", "M003");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M003-SUMMARY.md"), [
    "---",
    "id: M003",
    'title: "Budget tracking"',
    "status: complete",
    "key_decisions:",
    "  - Keep completion closeout in the same TUI surface.",
    "key_files:",
    "  - src/resources/extensions/gsd/auto-dashboard.ts",
    "lessons_learned:",
    "  - Milestone endings need report output, not auto-loop status.",
    "---",
    "",
    "# M003: Budget tracking",
    "",
    "**Added budget warning output and provider roll-up details.**",
    "",
    "## Success Criteria Results",
    "",
    "Budget warnings appear at milestone completion.",
    "",
    "## Definition of Done Results",
    "",
    "Completion leaves the report surface visible.",
    "",
    "## Requirement Outcomes",
    "",
    "Users can see what shipped without opening a fresh session.",
    "",
    "## Deviations",
    "",
    "None.",
    "",
    "## Follow-ups",
    "",
    "None.",
    "",
  ].join("\n"), "utf-8");

  autoSession.reset();
  openDatabase(join(base, "gsd-test.db"));
  insertMilestone({ id: "M003", title: "Budget tracking", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Complete slice", status: "complete", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Done slice", status: "done", sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M003", title: "Pending slice", status: "active", sequence: 3 });

  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M003");
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M003";
  autoSession.autoStartTime = Date.now() - 60_000;
  autoSession.cmdCtx = {
    newSession: async ({ workspaceRoot }: { workspaceRoot: string }) => {
      newSessionWorkspaces.push(workspaceRoot);
      widgetCalls.push(["gsd-progress", undefined]);
      return { cancelled: false };
    },
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 100, cacheRead: 900 },
          },
        },
      ],
    },
    getContextUsage: () => ({ percent: 0.9, contextWindow: 1_000_000 }),
    model: { contextWindow: 1_000_000 },
  } as any;

  try {
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: () => {},
        setWidget: (key: string, value: unknown) => {
          widgetCalls.push([key, value]);
        },
        setHeader: () => {},
        notify: (message: string) => {
          notifications.push(message);
        },
      },
      modelRegistry: { find: () => null },
    } as any;

    await stopAuto(
      ctx,
      { events: { emit: () => {} } } as any,
      "Milestone M003 complete",
      {
        completionWidget: {
          milestoneId: "M003",
          milestoneTitle: "Budget tracking",
        },
      },
    );

    assert.deepEqual(newSessionWorkspaces, [base], "completion stop must reroot command session to original project root");
    assert.equal(restoreCalls, 1, "completion stop must restore project root through lifecycle");
    assert.equal(realpathSync(process.cwd()), realpathSync(base), "completion stop must chdir back to project root");
    assert.equal(
      widgetCalls.some(([key, value]) => key === "gsd-progress" && typeof value === "function"),
      false,
      "foreground completion stop must not install a replacement roll-up widget over the transcript",
    );
    assert.ok(
      widgetCalls.some(([key, value]) => key === "gsd-progress" && value === undefined),
      "foreground completion stop must clear stale progress controls in the rerooted session",
    );
    assert.ok(
      notifications.every(message => !message.includes("/gsd auto to resume")),
      "completion stop notification must not tell users to resume a finished auto run",
    );
    assert.ok(
      notifications.every(message => !message.includes("Auto-mode stopped") && !message.includes("Session:") && !message.includes("Debug log written")),
      "completion stop must not append generic stop/session/debug notifications after the report",
    );
    const outcome = widgetCalls.find(([key, value]) => key === "gsd-outcome" && typeof value === "function")?.[1];
    assert.equal(
      typeof outcome,
      "function",
      "foreground completion stop must install a durable closeout outcome in the rerooted session",
    );
    const rendered = renderOutcomeWidget(outcome);
    assert.match(rendered, /Milestone M003 complete/);
    assert.match(rendered, /Review the closeout/);

    const widgetCallCountBeforePostLoopCleanup = widgetCalls.length;
    await cleanupAfterLoopExit(ctx);
    const postLoopWidgetCalls = widgetCalls.slice(widgetCallCountBeforePostLoopCleanup);
    assert.equal(
      postLoopWidgetCalls.some(([key, value]) => key === "gsd-progress" && value === undefined),
      false,
      "outer auto-loop cleanup must not touch the closeout surface after stopAuto returns",
    );
    assert.equal(
      postLoopWidgetCalls.some(([key]) => key === "gsd-outcome"),
      false,
      "outer auto-loop cleanup must not add a replacement outcome after stopAuto returns",
    );
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("stopAuto completion closeout emits a headless terminal notification without replacing the final widget", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-headless-completion-stop-"));
  const previousCwd = process.cwd();
  const previousHeadless = process.env.GSD_HEADLESS;
  const widgetCalls: Array<[string, unknown]> = [];
  const notifications: string[] = [];
  const milestoneDir = join(base, ".gsd", "milestones", "M003");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M003-SUMMARY.md"), [
    "---",
    "id: M003",
    'title: "Budget tracking"',
    "status: complete",
    "---",
    "",
    "# M003: Budget tracking",
    "",
    "**Completed budget tracking.**",
    "",
  ].join("\n"), "utf-8");

  autoSession.reset();
  openDatabase(join(base, "gsd-test.db"));
  insertMilestone({ id: "M003", title: "Budget tracking", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Complete slice", status: "complete", sequence: 1 });

  process.env.GSD_HEADLESS = "1";
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M003");
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M003";
  autoSession.autoStartTime = Date.now() - 60_000;
  autoSession.cmdCtx = {
    newSession: async () => ({ cancelled: false }),
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0.1, contextWindow: 1_000_000 }),
    model: { contextWindow: 1_000_000 },
  } as any;

  try {
    await stopAuto(
      {
        hasUI: true,
        ui: {
          setStatus: () => {},
          setWidget: (key: string, value: unknown) => {
            widgetCalls.push([key, value]);
          },
          setHeader: () => {},
          notify: (message: string) => {
            notifications.push(message);
          },
        },
        modelRegistry: { find: () => null },
      } as any,
      { events: { emit: () => {} } } as any,
      "Milestone M003 complete",
      {
        completionWidget: {
          milestoneId: "M003",
          milestoneTitle: "Budget tracking",
        },
      },
    );

    assert.ok(
      notifications.some(message => /^Auto-mode stopped/i.test(message) && /Milestone M003 complete/i.test(message)),
      "headless completion closeout must emit the terminal stop notification headless waits for",
    );
    assert.equal(
      typeof widgetCalls.filter(([key]) => key === "gsd-outcome").at(-1)?.[1],
      "function",
      "headless completion closeout must still leave the final roll-up widget installed",
    );
  } finally {
    if (previousHeadless === undefined) {
      delete process.env.GSD_HEADLESS;
    } else {
      process.env.GSD_HEADLESS = previousHeadless;
    }
    try { closeDatabase(); } catch { /* noop */ }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("stopAuto closeout-transcript preservation suppresses generic stop widgets", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-closeout-transcript-stop-"));
  const previousCwd = process.cwd();
  const widgetCalls: Array<[string, unknown]> = [];
  const notifications: string[] = [];

  autoSession.reset();
  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = base;
  autoSession.originalBasePath = base;

  try {
    await stopAuto(
      {
        hasUI: true,
        ui: {
          setStatus: () => {},
          setWidget: (key: string, value: unknown) => {
            widgetCalls.push([key, value]);
          },
          setHeader: () => {},
          notify: (message: string) => {
            notifications.push(message);
          },
        },
        modelRegistry: { find: () => null },
      } as any,
      { events: { emit: () => {} } } as any,
      "Pre-merge dirty working tree overlaps milestone M003",
      {
        preserveCloseoutTranscript: true,
        preserveCompletedMilestoneBranch: true,
      },
    );

    assert.equal(
      widgetCalls.some(([key]) => key === "gsd-outcome"),
      false,
      "closeout-preserving stop must not install a generic auto-stopped outcome",
    );
    assert.equal(
      widgetCalls.some(([key, value]) => key === "gsd-progress" && value === undefined),
      false,
      "closeout-preserving stop must not clear the transcript/progress surface",
    );
    assert.equal(
      notifications.some(message => message.includes("Auto-mode stopped")),
      false,
      "closeout-preserving stop must not append a duplicate terminal stop notification",
    );
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("stopAuto foreground all-complete closeout installs a durable terminal outcome", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-all-complete-closeout-"));
  const previousCwd = process.cwd();
  const widgetCalls: Array<[string, unknown]> = [];

  autoSession.reset();
  openDatabase(join(base, "gsd-test.db"));
  insertMilestone({ id: "M007", title: "Live Text Search", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M007", title: "Complete slice", status: "complete", sequence: 1 });

  autoSession.active = true;
  autoSession.paused = false;
  autoSession.basePath = join(base, ".gsd", "worktrees", "M007");
  autoSession.originalBasePath = base;
  autoSession.currentMilestoneId = "M007";
  autoSession.autoStartTime = Date.now() - 60_000;
  autoSession.cmdCtx = {
    newSession: async () => ({ cancelled: false }),
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0.1, contextWindow: 1_000_000 }),
    model: { contextWindow: 1_000_000 },
  } as any;

  try {
    await stopAuto(
      {
        hasUI: true,
        ui: {
          setStatus: () => {},
          setWidget: (key: string, value: unknown) => {
            widgetCalls.push([key, value]);
          },
          setHeader: () => {},
          notify: () => {},
        },
        modelRegistry: { find: () => null },
      } as any,
      { events: { emit: () => {} } } as any,
      "All milestones complete",
      {
        completionWidget: {
          milestoneId: "M007",
          milestoneTitle: "Live Text Search",
          allMilestonesComplete: true,
        },
      },
    );

    assert.equal(
      widgetCalls.some(([key, value]) => key === "gsd-progress" && typeof value === "function"),
      false,
      "foreground all-complete closeout must not replace the visible transcript with a roll-up widget",
    );
    const finalOutcome = widgetCalls.filter(([key]) => key === "gsd-outcome").at(-1)?.[1];
    assert.equal(
      typeof finalOutcome,
      "function",
      "foreground all-complete closeout must install a durable terminal outcome",
    );
    const rendered = renderOutcomeWidget(finalOutcome);
    assert.match(rendered, /All milestones complete/);
    assert.match(rendered, /start new work/);
  } finally {
    try { closeDatabase(); } catch { /* noop */ }
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});
