// Isolated child: module mocks affect the queried public entry, not other test files.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

const mode = process.argv[2];
assert.ok(mode === "resume" || mode === "fresh" || mode === "deferred" || mode === "deferred-normal");
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const resource = (name: string) => new URL(`../../${name}.${extension}`, import.meta.url).href;
const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-startup-rejection-")));
const cwd = process.cwd();
// Any resume resource synchronization belongs to the disposable fixture, never the installed runtime.
process.env.GSD_CODING_AGENT_DIR = join(base, "agent");

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture stalled at ${label}`)), 20_000);
    })]);
  } finally { clearTimeout(timer!); }
}

const db = await import(resource("gsd-db"));
const { openWorkflowDatabase } = await import(resource("db-workspace"));
const { seedLifecycles, cutOver } = await import(new URL(`./authority-cutover.${extension}`, import.meta.url).href);
const { autoSession } = await import(resource("auto-runtime-state"));
const { invalidateAllCaches } = await import(resource("cache"));
const actualState = await import(resource("state"));
const actualDoctor = await import(resource("doctor"));
const actualBootstrap = await import(resource("auto-start"));
const actualKernel = await import(resource("auto/lifecycle-kernel"));
const { scheduleAutoStartAfterIdle } = await import(resource("discussion-handoff"));
const idleGate = deferred(), deferredLaunched = deferred();
let deferredLaunches = 0;
const entered = deferred();
const held = deferred();
// The rejection is deliberately delivered only after stop completes.
void held.promise.catch(() => {});
let intercepted = false;
let postBootstrap = false;
let startup: typeof autoSession.pendingStart;
let doctorCalls = 0;
let kernelCalls = 0;
const emitted: Array<{ message?: string; action?: string }> = [];
const liveStartup = (path: string) => path === base && autoSession.pendingStart !== null &&
  !autoSession.pendingStart.cancelled && (!startup || startup === autoSession.pendingStart);
const suspend = () => {
  intercepted = true;
  startup = autoSession.pendingStart;
  entered.resolve();
  return held.promise;
};
const mocks = [
  mock.module(resource("state"), { cache: true, namedExports: {
    ...actualState,
    async deriveState(path: string, ...args: unknown[]) {
      if (mode === "fresh" && postBootstrap && !intercepted && liveStartup(path)) return suspend();
      return actualState.deriveState(path, ...args);
    },
  } }),
  mock.module(resource("doctor"), { cache: true, namedExports: {
    ...actualDoctor,
    async rebuildState(path: string, ...args: unknown[]) {
      if (mode === "resume" && autoSession.active && !intercepted && liveStartup(path)) return suspend();
      return actualDoctor.rebuildState(path, ...args);
    },
    async runGSDDoctor() { doctorCalls++; return { fixesApplied: [] }; },
  } }),
  mock.module(resource("auto-start"), { cache: true, namedExports: {
    ...actualBootstrap,
    bootstrapAutoSession: mode !== "resume" ? async (session: typeof autoSession,
      ctx: ExtensionCommandContext, _pi: ExtensionAPI, path: string,
      verbose: boolean, step: boolean) => {
      session.basePath = path; session.originalBasePath = path;
      if (mode === "deferred" || mode === "deferred-normal") {
        scheduleAutoStartAfterIdle(ctx, _pi, path, false, undefined, async () => {
          deferredLaunches++; deferredLaunched.resolve(); return true;
        });
        return false;
      }
      session.cmdCtx = ctx; session.active = true; session.paused = false;
      session.verbose = verbose; session.stepMode = step;
      session.currentMilestoneId = "M001";
      postBootstrap = true;
      return true;
    } : actualBootstrap.bootstrapAutoSession,
  } }),
  mock.module(resource("auto/lifecycle-kernel"), { cache: true, namedExports: {
    ...actualKernel,
    async kernelStart() { kernelCalls++; },
  } }),
];
try {
  autoSession.reset(); invalidateAllCaches(); actualState.invalidateStateCache();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openWorkflowDatabase(base, { createEmptyAuthority: true, bindCheckout: true }).ok, true);
  db.insertMilestone({ id: "M001", title: "Fixture", status: "active" });
  db.insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", depends: [] });
  db.insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  seedLifecycles("startup-rejection", [
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" },
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready" },
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "ready" },
  ]);
  cutOver();
  autoSession.basePath = base;
  autoSession.paused = mode === "resume";
  const ctx = { cwd: base, hasUI: true,
    ui: { notify() {}, setStatus() {}, setWidget() {}, setHeader() {} },
    sessionManager: { getSessionId: () => `startup-rejection-${mode}`, getEntries: () => [] },
    modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false, find: () => undefined },
    newSession: async () => ({ cancelled: false }), clearQueue() {},
    waitForIdle: () => idleGate.promise,
  } as unknown as ExtensionCommandContext;
  const pi = { events: { emit(_name: string, payload: { message?: string; action?: string }) { emitted.push(payload); } },
    getActiveTools: () => [], setActiveTools() {}, getThinkingLevel: () => "off", setThinkingLevel() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const auto = await import(`${resource("auto")}?startup-rejection=${mode}`);
  const starting = auto.startAuto(ctx, pi, base, false);
  if (mode === "deferred" || mode === "deferred-normal") {
    await bounded(starting, "nested guided fallback");
    assert.equal(autoSession.pendingStart, null, "original public startup must finish before the idle timer");
    const recognized = auto.isAutoStartPending();
    if (mode === "deferred") await bounded(auto.stopAuto(ctx, pi, "User requested stop"), "inactive deferred stop");
    idleGate.resolve();
    if (mode === "deferred-normal") await bounded(deferredLaunched.promise, "ordinary deferred handoff");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(deferredLaunches, mode === "deferred" ? 0 : 1,
      "stop must cancel the old handoff without breaking a normal post-startup idle launch");
    assert.equal(recognized, true, "stop routing must recognize the handoff after pendingStart clears");
    assert.equal(autoSession.pendingDeferredStarts.size, 0);
    console.log(JSON.stringify({ mode, passed: true, deferredLaunches }));
  } else {
  await bounded(entered.promise, "awaited startup operation");
  await bounded(auto.stopAuto(ctx, pi, "User requested stop"), "stop teardown");
  held.reject(new Error("Synthetic startup await rejected after cancellation"));
  await bounded(starting, "cancelled startup completion");
  assert.equal(doctorCalls, 0, "cancelled resume cannot run doctor fixes after a rejected rebuild");
  assert.equal(kernelCalls, 0, "cancelled startup cannot publish orchestration start after rejected deriveState");
  assert.equal(emitted.some((event) => event.message === "Auto-mode started."), false,
    "cancelled startup cannot emit its started notification");
  assert.equal(autoSession.active, false);
  assert.equal(autoSession.pendingStart, null);
  console.log(JSON.stringify({ mode, passed: true, doctorCalls, kernelCalls }));
  }
} finally {
  held.reject(new Error("Fixture cleanup"));
  autoSession.reset(); db.closeDatabase(); process.chdir(cwd);
  for (const module of mocks) module.restore();
  rmSync(base, { recursive: true, force: true });
}
