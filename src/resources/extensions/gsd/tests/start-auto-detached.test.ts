import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  _resolveEffectiveUnitIsolationModeForTest,
  _withDetachedAutoKeepaliveForTest,
} from "../auto.ts";
import {
  _scheduleAutoStartAfterIdleForTest,
  resolveGuidedExecuteLaunchMode,
} from "../guided-flow.ts";

const gsdDir = resolve(import.meta.dirname, "..");

function readGsdFile(relativePath: string): string {
  return readFileSync(resolve(gsdDir, relativePath), "utf-8");
}

function firstIndexOfAny(source: string, needles: string[]): number {
  const indexes = needles
    .map((needle) => source.indexOf(needle))
    .filter((index) => index > -1);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

test("command entrypoints use startAutoDetached instead of awaiting startAuto (#3733)", () => {
  const autoHandlerSrc = readGsdFile("commands/handlers/auto.ts");
  const workflowHandlerSrc = readGsdFile("commands/handlers/workflow.ts");
  const guidedFlowSrc = readGsdFile("guided-flow.ts");

  assert.ok(
    !autoHandlerSrc.includes("await startAuto("),
    "auto command handler should not await startAuto from the active agent turn",
  );
  assert.ok(
    !workflowHandlerSrc.includes("await startAuto("),
    "workflow command handler should not await startAuto from the active agent turn",
  );
  assert.ok(
    !guidedFlowSrc.includes("await startAuto("),
    "guided flow should not await startAuto from the active agent turn",
  );

  assert.ok(
    autoHandlerSrc.includes("startAutoDetached("),
    "auto command handler should launch auto-mode through startAutoDetached",
  );
  assert.ok(
    workflowHandlerSrc.includes("startAutoDetached("),
    "workflow handler should launch auto-mode through startAutoDetached",
  );
  assert.ok(
    guidedFlowSrc.includes("startAutoDetached("),
    "guided flow should launch auto-mode through startAutoDetached",
  );
});

test("bare /gsd stays in the foreground home flow (#5125 regression)", () => {
  const autoHandlerSrc = readGsdFile("commands/handlers/auto.ts");
  const bareCommandBranch = autoHandlerSrc.slice(
    autoHandlerSrc.indexOf('if (trimmed === "")'),
  );

  assert.ok(
    bareCommandBranch.includes('await import("../../gsd-command-home.js")'),
    "bare /gsd should load the state-aware home flow",
  );
  assert.ok(
    bareCommandBranch.includes("await showGsdHome(ctx, pi, projectRoot())"),
    "bare /gsd should await the foreground home menu instead of detaching auto-mode",
  );
  assert.ok(
    !bareCommandBranch.includes("startAutoDetached("),
    "bare /gsd must not enter detached auto bootstrap directly",
  );
});

test("guided execute uses auto step bootstrap when worktree isolation is enabled", () => {
  assert.equal(
    resolveGuidedExecuteLaunchMode("worktree"),
    "auto-step",
    "guided execute must enter auto bootstrap so the milestone worktree is created before execution",
  );
  assert.equal(
    resolveGuidedExecuteLaunchMode("none"),
    "guided-dispatch",
    "non-isolated projects can keep the foreground guided dispatch path",
  );
  assert.equal(
    resolveGuidedExecuteLaunchMode("branch"),
    "guided-dispatch",
    "this regression fix is scoped to worktree isolation",
  );
});

test("auto bootstrap validates blocked directories before touching .gsd migration state", () => {
  const autoSrc = readGsdFile("auto.ts");
  const autoStartSrc = readGsdFile("auto-start.ts");

  const startAutoIdx = autoSrc.indexOf("export async function startAuto(");
  const startAutoBody = autoSrc.slice(startAutoIdx);
  const startAutoValidationIdx = startAutoBody.indexOf("validateDirectory(base)");
  const startAutoRecoveryIdx = startAutoBody.indexOf("recoverFailedMigration(base)");

  assert.ok(startAutoIdx > -1, "startAuto should exist");
  assert.ok(startAutoValidationIdx > -1, "startAuto should validate the base directory");
  assert.ok(startAutoRecoveryIdx > -1, "startAuto should still recover failed migrations for safe projects");
  assert.ok(
    startAutoValidationIdx < startAutoRecoveryIdx,
    "startAuto must reject blocked directories before recovering or migrating .gsd state",
  );

  const bootstrapIdx = autoStartSrc.indexOf("export async function bootstrapAutoSession(");
  const bootstrapBody = autoStartSrc.slice(bootstrapIdx);
  const bootstrapValidationIdx = bootstrapBody.indexOf("validateDirectory(base)");
  const staleCrashReadIdx = bootstrapBody.indexOf("const startupLock = readCrashLock(base)");
  const staleCrashClearIdx = bootstrapBody.indexOf("clearLock(base);");
  const lockIdx = bootstrapBody.indexOf("acquireSessionLock(base)");
  const bootstrapMigrationIdx = bootstrapBody.indexOf("migrateToExternalState(base)");

  assert.ok(bootstrapIdx > -1, "bootstrapAutoSession should exist");
  assert.ok(bootstrapValidationIdx > -1, "bootstrapAutoSession should validate the base directory");
  assert.ok(lockIdx > -1, "bootstrapAutoSession should acquire a session lock for safe projects");
  assert.ok(bootstrapMigrationIdx > -1, "bootstrapAutoSession should still migrate safe projects");
  assert.ok(staleCrashReadIdx > -1, "bootstrapAutoSession should probe stale crash lock state before lock acquisition");
  assert.ok(staleCrashClearIdx > -1, "bootstrapAutoSession should clear stale crash lock state when detected");
  assert.ok(
    bootstrapValidationIdx < lockIdx && bootstrapValidationIdx < bootstrapMigrationIdx,
    "fresh bootstrap must reject blocked directories before locking or migrating .gsd state",
  );
  assert.ok(
    staleCrashReadIdx < lockIdx && staleCrashClearIdx < lockIdx,
    "fresh bootstrap must auto-clear stale crash lock state before session lock acquisition",
  );
});

test("fresh start registers the auto worker before bootstrap enters worktree flow (#5405)", () => {
  const autoSrc = readGsdFile("auto.ts");
  const autoStartSrc = readGsdFile("auto-start.ts");
  const startAutoIdx = autoSrc.indexOf("export async function startAuto(");
  const startAutoBody = autoSrc.slice(startAutoIdx);
  const bootstrapIdx = autoStartSrc.indexOf("export async function bootstrapAutoSession(");
  const bootstrapBody = autoStartSrc.slice(bootstrapIdx);

  const bootstrapCallIdx = startAutoBody.indexOf("const ready = await startupOwnership.run(() => bootstrapAutoSession(");
  const preBootstrapBody = startAutoBody.slice(0, bootstrapCallIdx);
  const preBootstrapRegisterIdx = preBootstrapBody.lastIndexOf("registerAutoWorkerForSession(s, base);");
  const resumeSectionIdx = startAutoBody.indexOf("if (s.paused) {");
  const freshStartSectionIdx = startAutoBody.indexOf("// ── Fresh start path — delegated to auto-start.ts ──");
  const resumeBody = startAutoBody.slice(resumeSectionIdx, freshStartSectionIdx);
  const resumeDbOpenIdx = resumeBody.indexOf("await openProjectDbIfPresent(base);");
  const resumeRegisterIdx = resumeBody.indexOf("registerAutoWorkerForSession(s, base);");
  const resumeEnterMilestoneIdx = resumeBody.indexOf("buildLifecycle().enterMilestone");
  const dbOpenIdx = bootstrapBody.indexOf("await openProjectDbIfPresent(base);");
  const bootstrapRegisterIdx = bootstrapBody.indexOf("registerAutoWorkerForSession(base);");
  const enterMilestoneIdx = firstIndexOfAny(bootstrapBody, [
    "buildLifecycle().enterMilestone",
    "lifecycle.enterMilestone",
    "lifecycle.adoptStrandedMilestone",
  ]);

  assert.ok(startAutoIdx > -1, "startAuto should exist");
  assert.ok(preBootstrapRegisterIdx > -1, "startAuto should register worker before bootstrap");
  assert.ok(bootstrapCallIdx > -1, "startAuto should call bootstrapAutoSession");
  assert.ok(resumeSectionIdx > -1, "startAuto should have resume milestone entry flow");
  assert.ok(freshStartSectionIdx > resumeSectionIdx, "resume assertions should be scoped before fresh start");
  assert.ok(resumeDbOpenIdx > -1, "resume should open DB before milestone entry");
  assert.ok(resumeRegisterIdx > -1, "resume should register worker before milestone entry");
  assert.ok(resumeEnterMilestoneIdx > -1, "resume should enter milestones through lifecycle");
  assert.ok(bootstrapIdx > -1, "bootstrapAutoSession should exist");
  assert.ok(dbOpenIdx > -1, "bootstrap should open the project DB");
  assert.ok(bootstrapRegisterIdx > -1, "bootstrap should register worker after DB open");
  assert.ok(enterMilestoneIdx > -1, "bootstrap should enter or adopt milestones through lifecycle");
  assert.ok(
    preBootstrapRegisterIdx < bootstrapCallIdx,
    "worker registration must happen before bootstrap so enterMilestone can claim milestone leases on first entry",
  );
  assert.ok(
    dbOpenIdx < bootstrapRegisterIdx && bootstrapRegisterIdx < enterMilestoneIdx,
    "bootstrap must open DB and register worker before first enterMilestone",
  );
  assert.ok(
    resumeDbOpenIdx < resumeRegisterIdx &&
      resumeRegisterIdx < resumeEnterMilestoneIdx,
    "resume must open DB and register worker before first enterMilestone",
  );
});

test("startAutoDetached reports failures asynchronously (#3733)", () => {
  const autoSrc = readGsdFile("auto.ts");

  assert.ok(
    autoSrc.includes("export function startAutoDetached"),
    "auto.ts should export startAutoDetached",
  );
  assert.ok(
    /void withDetachedAutoKeepalive\(\s*startAutoWithAcknowledgement\(ctx, pi, base, verboseMode, options, resolve\),?\s*\)\.catch/.test(autoSrc),
    "startAutoDetached should launch startAuto without awaiting it and keep the process alive",
  );
  assert.ok(
    autoSrc.includes("ctx.ui.notify(`Auto-start failed: ${message}`, \"error\")"),
    "startAutoDetached should surface async startup failures to the user",
  );
});

test("failed auto-start always clears leaked s.active so later /gsd auto is not bricked (#1235)", () => {
  const autoSrc = readGsdFile("auto.ts");

  // 1. Both start entry points share the acknowledgement runner. Its finally
  //    must clear activation leaked by a pre-loop exception, but only for its
  //    own pending start and never concurrently with an explicit stop.
  const detachedIdx = autoSrc.indexOf("export function startAutoDetached");
  assert.ok(detachedIdx > -1, "startAutoDetached should exist");
  const detachedBody = autoSrc.slice(detachedIdx, autoSrc.indexOf("\n}", detachedIdx));
  const acknowledgementIdx = autoSrc.indexOf("async function startAutoWithAcknowledgement(");
  assert.ok(acknowledgementIdx > -1, "shared startup runner must exist");
  const acknowledgementBody = autoSrc.slice(acknowledgementIdx, autoSrc.indexOf("\n}", acknowledgementIdx));
  assert.ok(
    detachedBody.includes("startAutoWithAcknowledgement(") &&
      acknowledgementBody.includes("finally {") &&
      acknowledgementBody.includes("if (!startup.accepted)") &&
      acknowledgementBody.includes("if (s.pendingStart === startup && s.active && !s.stopInProgress)") &&
      acknowledgementBody.includes("await cleanupAfterLoopExit(ctx)"),
    "shared startup finally must clean up a leaked activation only for its owning, unaccepted start",
  );

  // 2. bootstrapAutoSession sets s.active = true before some bail-outs return
  //    false (e.g. the SQLite-unavailable gate), so the fresh-start !ready path
  //    must clear the leaked activation before returning.
  const startAutoIdx = autoSrc.indexOf("export async function startAuto(");
  assert.ok(startAutoIdx > -1, "startAuto should exist");
  const startAutoBody = autoSrc.slice(startAutoIdx);
  const notReadyIdx = startAutoBody.indexOf("if (!ready) {");
  assert.ok(notReadyIdx > -1, "fresh start should guard on bootstrap readiness with a block body");
  const notReadyBlock = startAutoBody.slice(notReadyIdx, notReadyIdx + 600);
  assert.ok(
    notReadyBlock.includes("if (s.active) await cleanupAfterLoopExit(ctx)"),
    "fresh-start !ready bail-out must clear leaked auto activation before returning",
  );
});

test("detached auto-start keeps a ref'ed handle until the run settles", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCreated = false;
  let intervalCleared = false;
  let createdHandle: NodeJS.Timeout | undefined;
  let resolveRun!: () => void;
  const run = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    intervalCreated = true;
    assert.equal(timeout, 30_000);
    void handler;
    void args;
    createdHandle = originalSetInterval(() => {}, 1_000_000);
    assert.equal(createdHandle.hasRef(), true, "detached auto keepalive must be ref'ed");
    return createdHandle;
  }) as unknown as typeof setInterval;

  globalThis.clearInterval = ((handle?: NodeJS.Timeout | number | string) => {
    if (handle === createdHandle) intervalCleared = true;
    return originalClearInterval(handle);
  }) as unknown as typeof clearInterval;

  try {
    const heldRun = _withDetachedAutoKeepaliveForTest(run);
    assert.equal(intervalCreated, true, "keepalive interval should start immediately");
    assert.equal(intervalCleared, false, "keepalive should remain active while auto-mode is running");

    resolveRun();
    await heldRun;

    assert.equal(intervalCleared, true, "keepalive interval should clear when auto-mode settles");
  } finally {
    if (createdHandle) originalClearInterval(createdHandle);
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("detached auto-start preserves milestone lock across pause/stop cleanup (#3733)", () => {
  const autoSrc = readGsdFile("auto.ts");
  const sessionSrc = readGsdFile("auto/session.ts");

  assert.ok(
    autoSrc.includes("milestoneLock?: string | null"),
    "startAuto/startAutoDetached options should carry an explicit milestone lock",
  );
  assert.ok(
    autoSrc.includes("s.sessionMilestoneLock = options.milestoneLock ?? null;"),
    "startAuto should capture the requested milestone lock before async work begins",
  );
  assert.ok(
    autoSrc.includes("milestoneLock: s.sessionMilestoneLock ?? undefined"),
    "pause metadata should persist the detached milestone lock for resume",
  );
  assert.ok(
    autoSrc.includes("s.sessionMilestoneLock = meta.milestoneLock ?? null;"),
    "resume should restore the persisted milestone lock",
  );
  assert.ok(
    autoSrc.includes("restoreMilestoneLockEnv();"),
    "auto cleanup should restore the previous process milestone-lock env",
  );

  assert.ok(
    sessionSrc.includes("sessionMilestoneLock: string | null = null;"),
    "AutoSession should track the detached milestone lock explicitly",
  );
});

test("discussion auto-start waits for the current command context to become idle", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolveIdle) => {
    releaseIdle = resolveIdle;
  });
  const launches: unknown[][] = [];
  const ctx = {
    waitForIdle: () => idle,
    ui: {
      notify: () => {},
    },
  } as any;

  _scheduleAutoStartAfterIdleForTest(
    ctx,
    {} as any,
    "/tmp/gsd-auto-start-idle-test",
    false,
    { step: true },
    async (...args: unknown[]) => {
      launches.push(args);
      return true;
    }
  );

  await Promise.resolve();
  assert.equal(launches.length, 0, "auto-start must not launch before waitForIdle resolves");

  releaseIdle();
  await Promise.resolve();
  assert.equal(launches.length, 0, "auto-start should defer launch to the next timer turn");

  await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
  assert.equal(launches.length, 1);
  assert.equal(launches[0][2], "/tmp/gsd-auto-start-idle-test");
  assert.deepEqual(launches[0][4], { step: true });
});

test("resume path only hard-exits on blocked stop, not blocked pause (#6154)", () => {
  const autoSrc = readGsdFile("auto.ts");
  const startAutoIdx = autoSrc.indexOf("export async function startAuto(");
  const startAutoBody = autoSrc.slice(startAutoIdx);
  const resumeSectionIdx = startAutoBody.indexOf("if (s.paused) {");
  const freshStartSectionIdx = startAutoBody.indexOf("// ── Fresh start path — delegated to auto-start.ts ──");
  const resumeBody = startAutoBody.slice(resumeSectionIdx, freshStartSectionIdx);

  assert.ok(startAutoIdx > -1, "startAuto should exist");
  assert.ok(resumeSectionIdx > -1, "resume path should exist");
  assert.ok(freshStartSectionIdx > resumeSectionIdx, "resume assertions should be scoped before fresh start");
  assert.ok(
    resumeBody.includes('if (resumeResult?.kind === "blocked" && resumeResult.action === "stop")'),
    "resume path should only hard-stop blocked resume when action is stop",
  );
  assert.ok(
    resumeBody.includes('if (resumeResult?.kind === "blocked")'),
    "resume path should still notify blocked resume results",
  );
});

test("prepareForUnit enforces worktree safety for all isolation modes (#6154)", () => {
  const orchSrc = readGsdFile("auto/orchestrator.ts");
  const prepareForUnitIdx = orchSrc.indexOf("private async prepareWorktreeForUnit(");
  const prepareForUnitBody = orchSrc.slice(prepareForUnitIdx, orchSrc.indexOf("private classifyAndRecover(", prepareForUnitIdx));

  assert.ok(prepareForUnitIdx > -1, "prepareForUnit should exist");
  assert.ok(
    prepareForUnitBody.includes("const isolationMode = this.getEffectiveUnitIsolationMode(this.runtimeBasePath);"),
    "prepareForUnit should resolve the effective isolation mode once",
  );
  assert.ok(
    prepareForUnitBody.includes('const writeScope ='),
    "prepareForUnit should classify the unit's write scope before validating",
  );
  assert.ok(
    !prepareForUnitBody.includes('if (isolationMode !== "worktree")'),
    "prepareForUnit must not bypass worktree safety outside worktree isolation mode",
  );
});

test("effective unit isolation follows degraded branch fallback", () => {
  assert.equal(_resolveEffectiveUnitIsolationModeForTest("worktree", true), "branch");
  assert.equal(_resolveEffectiveUnitIsolationModeForTest("worktree", false), "worktree");
  assert.equal(_resolveEffectiveUnitIsolationModeForTest("branch", true), "branch");
  assert.equal(_resolveEffectiveUnitIsolationModeForTest("none", true), "none");
});

test("discuss-to-auto handoff defaults to step mode unless explicitly disabled", () => {
  const guidedFlowSrc = readGsdFile("guided-flow.ts");
  const discussionHandoffSrc = readGsdFile("discussion-handoff.ts");
  const workflowSrc = readGsdFile("commands/handlers/workflow.ts");

  assert.ok(
    !guidedFlowSrc.includes("step: false"),
    "guided-flow must not hardcode step: false on pending auto-start entries",
  );
  assert.match(
    discussionHandoffSrc,
    /scheduleAutoStartAfterIdle\(ctx, pi, basePath, false, \{ step: step \?\? true \}\)/,
    "checkAutoStartAfterDiscuss should default missing step flags to step mode",
  );
  assert.match(
    guidedFlowSrc,
    /const stepMode = options\?\.step \?\? true;/,
    "showSmartEntry should default to step mode",
  );
  assert.match(
    workflowSrc,
    /await showSmartEntry\(ctx, pi, basePath, \{ step: true \}\);/,
    "new-milestone/new-project entrypoints should preserve step mode",
  );
});
