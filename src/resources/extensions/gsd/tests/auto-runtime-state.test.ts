// Project/App: gsd-pi
// File Purpose: Auto runtime state snapshot regression tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoSession,
  clearAutoToolSurfaceSnapshot,
  clearToolInvocationError,
  getAutoRuntimeSnapshot,
  recordAutoToolSurfaceSnapshot,
} from "../auto-runtime-state.ts";
import {
  readUnitHarnessAbort,
  recordUnitHarnessAbort,
} from "../unit-runtime.ts";

test("getAutoRuntimeSnapshot includes orchestration phase when available", () => {
  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
  autoSession.active = true;
  autoSession.basePath = "/tmp/project";
  autoSession.orchestration = {
    async start() { return { kind: "stopped" as const, reason: "test" }; },
    async advance() { return { kind: "stopped" as const, reason: "test" }; },
    async settle() {},
    async completeActiveUnit() {},
    async retryActiveUnit() {},
    async abandonActiveUnit() {},
    async resume() { return { kind: "stopped" as const, reason: "test" }; },
    async stop() { return { kind: "stopped" as const, reason: "test" }; },
    getStatus() {
      return { phase: "running" as const, transitionCount: 3, lastTransitionAt: 123 };
    },
  };

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.active, true);
  assert.equal(snap.basePath, "/tmp/project");
  assert.equal(snap.orchestrationPhase, "running");
  assert.equal(snap.orchestrationTransitionCount, 3);
  assert.equal(snap.orchestrationLastTransitionAt, 123);
  assert.equal(snap.toolSurface, null);

  autoSession.reset();
});

test("getAutoRuntimeSnapshot includes session isolation fallback state", (t) => {
  autoSession.reset();
  t.after(() => autoSession.reset());
  autoSession.isolationDegraded = true;
  autoSession.strandedRecoveryIsolationMode = "branch";

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.isolationDegraded, true);
  assert.equal(snap.strandedRecoveryIsolationMode, "branch");
});

test("getAutoRuntimeSnapshot includes the active typed tool-surface snapshot", () => {
  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
  autoSession.active = true;

  recordAutoToolSurfaceSnapshot({
    source: "dispatch-scope",
    unitType: "run-uat",
    modelFacingToolNames: ["read", "read", "gsd_uat_exec"],
    registeredToolNames: ["read", "browser_navigate"],
    scopedToolNames: ["read", "browser_navigate"],
    presentedToolNames: ["gsd_uat_exec"],
    capturedAt: 123,
  });

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.toolSurface?.source, "dispatch-scope");
  assert.equal(snap.toolSurface?.unitType, "run-uat");
  assert.deepEqual(snap.toolSurface?.modelFacingToolNames, ["read", "gsd_uat_exec"]);
  assert.deepEqual(snap.toolSurface?.registeredToolNames, ["read", "browser_navigate"]);
  assert.deepEqual(snap.toolSurface?.scopedToolNames, ["read", "browser_navigate"]);
  assert.deepEqual(snap.toolSurface?.presentedToolNames, ["gsd_uat_exec"]);
  assert.equal(snap.toolSurface?.capturedAt, 123);

  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
});

test("clearToolInvocationError clears stale tool error state for active auto sessions", () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.lastToolInvocationError = "gsd_task_complete: simulated transient tool error";

  clearToolInvocationError();

  assert.equal(autoSession.lastToolInvocationError, null);
  autoSession.reset();
});

test("clearToolInvocationError clears stale tool error even when a harness abort is durable", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-auto-runtime-state-"));
  const startedAt = 123456;
  try {
    autoSession.reset();
    autoSession.active = true;
    autoSession.basePath = base;
    autoSession.setCurrentUnit({
      type: "gate-evaluate",
      id: "M001/S01/gates+Q3",
      startedAt,
      workspaceRoot: base,
    });
    autoSession.lastToolInvocationError = "gsd_save_gate_result: simulated stale tool error";
    recordUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt, {
      kind: "tool-error",
      reason: "Tool execution failed before the unit could complete its gate evaluation.",
      toolName: "gsd_uat_exec",
    });

    clearToolInvocationError();

    assert.equal(autoSession.lastToolInvocationError, null);
    assert.equal(
      readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt)?.kind,
      "tool-error",
      "durable harness abort remains available for result-save blocking",
    );
  } finally {
    autoSession.reset();
    rmSync(base, { recursive: true, force: true });
  }
});

test("getAutoRuntimeSnapshot omits orchestration phase when seam not wired", () => {
  autoSession.reset();

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.orchestrationPhase, undefined);
  assert.equal(snap.orchestrationTransitionCount, undefined);
  assert.equal(snap.orchestrationLastTransitionAt, undefined);
  assert.equal(snap.toolSurface, null);
});
