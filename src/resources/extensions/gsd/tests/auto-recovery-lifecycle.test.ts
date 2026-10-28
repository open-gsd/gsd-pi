// Project/App: gsd-pi
// File Purpose: Real-entry startup acknowledgement, stop, and consent lifecycle regressions.
// All databases are temporary. Native approval keys are synthetic fixture input,
// not evidence of an actual operator's runtime approval.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import * as auto from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { authorizeAutoRecovery } from "../auto-recovery-authorization.ts";
import { COMPLETED_NO_ADVANCE_GUARD_ID, recordNonAdvancingOutcome, snapshotUnitTargetRows } from "../auto-liveness-backstop.ts";
import { invalidateAllCaches } from "../cache.ts";
import { handleAutoCommand } from "../commands/handlers/auto.ts";
import { openAutoPause } from "../db/writers/auto-pauses.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";
import { _getAdapter, closeDatabase, insertAssessment, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";
import { normalizeRealPath } from "../paths.ts";
import type { RecoveryClassification } from "../recovery-classification.ts";
import { invalidateStateCache } from "../state.ts";
import { cutOver, seedLifecycles } from "./helpers/authority-cutover.ts";

const RETRY: RecoveryClassification = { failureKind: "tool-schema", action: "retry",
  reason: "Mechanical schema correction", exitReason: "retry", remediation: "Retry corrected operation" };
const OPTIONS = { timeout: 15_000 };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function events(type: string) {
  const db = _getAdapter(); assert.ok(db);
  return db.prepare(`SELECT entity_id FROM workflow_domain_events
    WHERE entity_type = 'auto-recovery-authorization' AND event_type = :type
    ORDER BY project_revision, event_index`).all({ ":type": type }) as Array<{ entity_id: string }>;
}
function fixture(t: TestContext, blocked = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-recovery-lifecycle-")));
  const cwd = process.cwd(); const project = process.env.GSD_PROJECT_ID;
  autoSession.reset(); invalidateAllCaches(); invalidateStateCache();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openWorkflowDatabase(base, { createEmptyAuthority: true, bindCheckout: true }).ok, true);
  insertMilestone({ id: "M001", title: "Fixture", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: blocked ? "complete" : "active", depends: [] });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: blocked ? "complete" : "pending" });
  seedLifecycles("auto-recovery-lifecycle", [
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" },
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: blocked ? "completed" : "ready" },
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: blocked ? "completed" : "ready" },
  ]);
  cutOver();
  if (blocked) insertAssessment({ path: join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    milestoneId: "M001", status: "needs-attention", scope: "milestone-validation", fullContent: "---\nverdict: needs-attention\n---" });
  autoSession.basePath = base;
  t.after(() => {
    autoSession.reset(); closeDatabase(); process.chdir(cwd);
    if (project === undefined) delete process.env.GSD_PROJECT_ID; else process.env.GSD_PROJECT_ID = project;
    invalidateAllCaches(); invalidateStateCache(); rmSync(base, { recursive: true, force: true });
  });
  return base;
}
function host(t: TestContext, base: string, hold = false) {
  const outcomes: Array<{ type: string; status: string }> = [];
  const notices: string[] = []; const ready = deferred<void>(); const outcome = deferred<void>();
  let component: { handleInput(data: string): void } | undefined;
  let prompts = 0; let onNotice: ((message: string) => void) | undefined;
  const ctx = { cwd: base, hasUI: true, ui: {
    notify(message: string) { notices.push(message); onNotice?.(message); },
    setStatus() {}, setWidget() {}, setHeader() {},
    custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { handleInput(data: string): void }) {
      prompts++;
      return new Promise<void>((resolve) => {
        component = factory({}, {}, {}, resolve); ready.resolve();
        if (!hold) component.handleInput("y");
      });
    },
  }, sessionManager: { getSessionId: () => "auto-recovery-lifecycle-test", getEntries: () => [] },
    modelRegistry: { getAvailable: () => [], isProviderRequestReady: () => false, find: () => undefined },
    newSession: async () => ({ cancelled: false }), clearQueue() {},
  } as unknown as ExtensionCommandContext;
  const pi = { events: { emit() {} }, getActiveTools: () => [], setActiveTools() {},
    getThinkingLevel: () => "off", setThinkingLevel() {},
    sendMessage(message: { content: string }) {
      let value: { type?: string; status?: string };
      try { value = JSON.parse(message.content); } catch { return; }
      if (value.type === "workflow_outcome") {
        outcomes.push(value as { type: string; status: string }); outcome.resolve();
      }
    },
  } as unknown as ExtensionAPI;
  t.after(() => component?.handleInput("n"));
  return { ctx, pi, notices, outcomes, ready: ready.promise, outcome: outcome.promise,
    get prompts() { return prompts; }, key: (key: string) => component?.handleInput(key),
    onNotice: (callback: (message: string) => void) => { onNotice = callback; } };
}
function approval() {
  const authorizationId = randomUUID(), runId = randomUUID(), fence = readDomainOperationFence();
  authorizeAutoRecovery({ authorizationId, runId, expectedProjectId: fence.projectId,
    expectedRevision: fence.revision, expectedAuthorityEpoch: fence.authorityEpoch });
  return { authorizationId, runId };
}
function attach(value = approval()) {
  autoSession.autoRecoveryAuthorizationId = value.authorizationId;
  autoSession.autoRecoveryRunId = value.runId;
  return value;
}
function pause(ctx: ExtensionCommandContext, base: string) {
  openAutoPause({ pauseId: randomUUID(), milestoneId: "M001", unitType: "execute-task", unitId: "M001/S01/T01",
    pausedAt: new Date().toISOString(), dispatchId: null, stepMode: false, blockerKind: "machine_fixable",
    pauseReason: "recovery:tool-schema/retry | Mechanical correction" });
  autoSession.basePath = base; autoSession.paused = true; autoSession.cmdCtx = ctx;
}
function wedge(base: string) {
  const snapshot = snapshotUnitTargetRows("complete-slice", "M001/S01"); assert.ok(snapshot.ok && snapshot.hash);
  const record = () => recordNonAdvancingOutcome({ scopeId: normalizeRealPath(base),
    guardId: COMPLETED_NO_ADVANCE_GUARD_ID, unitType: "complete-slice", unitId: "M001/S01", inputPayload: snapshot.hash! });
  assert.equal(record().tripped, false); assert.equal(record().tripped, true);
}

test("real queued stop detaches before its first await and durably revokes before DB teardown", OPTIONS, async (t) => {
  const base = fixture(t), h = host(t, base), consent = attach(); pause(h.ctx, base);
  let calls = 0;
  assert.equal(auto._queueApprovedAutoRecoveryForTest(h.pi, RETRY, (...args) => { calls++; return auto.startAutoDetached(...args); }), true);
  const stopping = auto.stopAuto(h.ctx, h.pi, "User requested stop");
  assert.equal(autoSession.autoRecoveryAuthorizationId, null);
  assert.equal(autoSession.autoRecoveryRunId, null); assert.equal(autoSession.autoRecoveryPending, null);
  assert.deepEqual(events("auto.recovery.revoked").map((e) => e.entity_id), [consent.authorizationId]);
  await stopping; await turn(); assert.equal(calls, 0);
  assert.equal(openWorkflowDatabase(base).ok, true);
  assert.equal(events("auto.recovery.revoked").length, 1);
});

test("command stop cancels pending native consent and a late approval key cannot start", OPTIONS, async (t) => {
  const base = fixture(t, true), h = host(t, base, true);
  const starting = auto.startAuto(h.ctx, h.pi, base, false, { autoRecover: true });
  await h.ready; assert.equal(auto.isAutoStartPending(), true);
  await handleAutoCommand("stop", h.ctx, h.pi);
  assert.equal(await auto.startAutoDetached(h.ctx, h.pi, base, false), false, "old startup retains its unwind barrier");
  h.key("y"); await starting;
  assert.equal(events("auto.recovery.authorized").length, 0);
  assert.equal(autoSession.autoRecoveryAuthorizationId, null); assert.equal(autoSession.active, false);
});

for (const kind of ["validation", "wedge"] as const) {
  test(`new native consent rolls back on ${kind} refusal and ordinary later auto cannot inherit it`, OPTIONS, async (t) => {
    const base = fixture(t, kind === "validation"), h = host(t, base);
    if (kind === "wedge") wedge(base);
    await auto.startAuto(h.ctx, h.pi, base, false, { autoRecover: true });
    assert.equal(h.prompts, 1); assert.equal(events("auto.recovery.authorized").length, 1);
    assert.equal(events("auto.recovery.revoked").length, 1);
    assert.equal(autoSession.autoRecoveryAuthorizationId, null); assert.equal(autoSession.autoRecoveryRunId, null);
    await auto.stopAuto(h.ctx, h.pi, "User requested stop");
    assert.equal(await auto.startAutoDetached(h.ctx, h.pi, base, false), false);
    assert.equal(h.prompts, 1); assert.equal(events("auto.recovery.authorized").length, 1);
    assert.equal(autoSession.autoRecoveryAuthorizationId, null);
  });
  test(`real queued ${kind} refusal emits one blocked outcome rather than swallowing it`, OPTIONS, async (t) => {
    const base = fixture(t, kind === "validation"), h = host(t, base); attach(); pause(h.ctx, base);
    if (kind === "wedge") wedge(base);
    assert.equal(auto._queueApprovedAutoRecoveryForTest(h.pi, RETRY), true);
    await h.outcome; await turn();
    assert.deepEqual(h.outcomes.map((o) => o.status), ["blocked"]);
  });
}

test("stop cancels an in-flight queued startup without a second terminal outcome", OPTIONS, async (t) => {
  const base = fixture(t), h = host(t, base); attach(); pause(h.ctx, base);
  const began = deferred<void>(), ack = deferred<boolean>();
  assert.equal(auto._queueApprovedAutoRecoveryForTest(h.pi, RETRY, () => { began.resolve(); return ack.promise; }), true);
  await began.promise; await auto.stopAuto(h.ctx, h.pi, "User requested stop");
  const before = h.outcomes.length; ack.resolve(false); await turn();
  assert.equal(h.outcomes.length, before);
});

test("refused in-flight startup reset still owes exactly one blocked outcome", OPTIONS, async (t) => {
  const base = fixture(t), h = host(t, base); attach(); pause(h.ctx, base);
  assert.equal(auto._queueApprovedAutoRecoveryForTest(h.pi, RETRY, async () => { autoSession.reset(); return false; }), true);
  await h.outcome; await turn(); assert.deepEqual(h.outcomes.map((o) => o.status), ["blocked"]);
});

test("undefined resume return is not a startup acceptance acknowledgement", OPTIONS, async (t) => {
  const base = fixture(t), h = host(t, base); attach(); pause(h.ctx, base);
  assert.equal(auto._queueApprovedAutoRecoveryForTest(h.pi, RETRY,
    (() => undefined) as unknown as typeof auto.startAutoDetached), true);
  await h.outcome; assert.deepEqual(h.outcomes.map((o) => o.status), ["blocked"]);
});

test("startup exception rolls back its own consent and public start still rejects", OPTIONS, async (t) => {
  const base = fixture(t, true), h = host(t, base); let thrown = false;
  h.onNotice(() => { if (!thrown && events("auto.recovery.authorized").length) { thrown = true; throw new Error("fixture startup failure"); } });
  await assert.rejects(auto.startAuto(h.ctx, h.pi, base, false, { autoRecover: true }), /fixture startup failure/);
  assert.equal(events("auto.recovery.revoked").length, 1); assert.equal(autoSession.autoRecoveryAuthorizationId, null);
});

test("rollback revokes only its newly issued consent, preserving a newer attachment", OPTIONS, async (t) => {
  const base = fixture(t, true), h = host(t, base); let newer: ReturnType<typeof approval> | undefined;
  h.onNotice(() => { if (!newer && events("auto.recovery.authorized").length) newer = attach(); });
  assert.equal(await auto.startAutoDetached(h.ctx, h.pi, base, false, { autoRecover: true }), false);
  assert.ok(newer); assert.equal(autoSession.autoRecoveryAuthorizationId, newer.authorizationId);
  assert.equal(events("auto.recovery.revoked").length, 1);
  assert.notEqual(events("auto.recovery.revoked")[0]?.entity_id, newer.authorizationId);
});

test("revocation failure cannot skip unconditional stop teardown", OPTIONS, async (t) => {
  const base = fixture(t), h = host(t, base); attach(); pause(h.ctx, base); closeDatabase();
  await auto.stopAuto(h.ctx, h.pi, "User requested stop");
  assert.equal(autoSession.active, false); assert.equal(autoSession.paused, false);
  assert.equal(autoSession.autoRecoveryAuthorizationId, null); assert.equal(autoSession.stopInProgress, false);
});

test("stop fences real bootstrap at provider readiness before model, guided or worktree continuation", OPTIONS, async (t) => {
  const base = fixture(t), h = host(t, base);
  const entered = deferred<void>(), release = deferred<void>();
  const originalCwd = process.cwd();
  let stopped = false, staleModelReads = 0, sends = 0;
  Object.defineProperty(h.ctx, "model", { get() {
    if (stopped) staleModelReads++;
    return undefined;
  } });
  h.ctx.modelRegistry.settleProviderReadiness = async () => {
    entered.resolve(); await release.promise;
  };
  h.pi.sendMessage = async () => { sends++; };
  const starting = auto.startAuto(h.ctx, h.pi, base, false);
  t.after(() => release.resolve());
  await entered.promise;
  await auto.stopAuto(h.ctx, h.pi, "User requested stop");
  stopped = true;
  release.resolve();
  await starting;
  assert.equal(staleModelReads, 0, "cancelled bootstrap must stop at the awaited readiness boundary");
  assert.equal(sends, 0, "cancelled bootstrap cannot dispatch guided work");
  assert.equal(autoSession.active, false);
  assert.equal(autoSession.pendingStart, null);
  assert.equal(process.cwd(), originalCwd, "cancelled bootstrap cannot enter a worktree");
});
