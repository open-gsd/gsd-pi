// Project/App: gsd-pi
// File Purpose: Verifies UOK kernel path selection and legacy fallback telemetry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { runAutoLoopWithUok } from "../uok/kernel.ts";
import type { AutoSession } from "../auto/session.ts";
import type { LoopDeps } from "../auto/loop-deps.ts";
import { gsdRoot } from "../paths.ts";
import type { GSDPreferences } from "../preferences.ts";
import { getLegacyTelemetry, resetLegacyTelemetry } from "../legacy-telemetry.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { UokGateRunner } from "../uok/gate-runner.ts";
import { applyModelPolicyFilter } from "../uok/model-policy.ts";
import {
  clearUnifiedAuditOverrideForTests,
  isUnifiedAuditEnabled,
  setUnifiedAuditEnabled,
} from "../uok/audit-toggle.ts";
import { writeEscalationArtifact } from "../escalation.ts";
import { peekLogs, _resetLogs } from "../workflow-logger.ts";

function makeBasePath(): string {
  return mkdtempSync(join(tmpdir(), "gsd-uok-kernel-"));
}

function makeArgs(
  basePath: string,
  preferences: GSDPreferences | undefined,
): {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  s: AutoSession;
  deps: LoopDeps;
  runKernelLoop: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    s: AutoSession,
    deps: LoopDeps,
  ) => Promise<void>;
  runLegacyLoop: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    s: AutoSession,
    deps: LoopDeps,
  ) => Promise<void>;
  calls: {
    kernel: number;
    legacy: number;
    kernelDeps: LoopDeps | null;
    legacyDeps: LoopDeps | null;
  };
} {
  const calls = {
    kernel: 0,
    legacy: 0,
    kernelDeps: null as LoopDeps | null,
    legacyDeps: null as LoopDeps | null,
  };

  return {
    ctx: {
      sessionManager: {
        getSessionId: (): string => "session-test",
      },
    } as unknown as ExtensionContext,
    pi: {} as unknown as ExtensionAPI,
    s: {
      basePath,
      autoStartTime: 1,
    } as unknown as AutoSession,
    deps: {
      loadEffectiveGSDPreferences: () => ({ preferences }),
    } as unknown as LoopDeps,
    runKernelLoop: async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      calls.kernel += 1;
      calls.kernelDeps = loopDeps;
    },
    runLegacyLoop: async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      calls.legacy += 1;
      calls.legacyDeps = loopDeps;
    },
    calls,
  };
}

function readParityEvents(basePath: string): Array<Record<string, unknown>> {
  const file = join(gsdRoot(basePath), "runtime", "uok-parity.jsonl");
  const raw = readFileSync(file, "utf-8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

test("runAutoLoopWithUok uses kernel path by default and records uok-kernel parity", async () => {
  const basePath = makeBasePath();
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        audit_unified: { enabled: false },
        gitops: { enabled: false },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 1);
    assert.equal(args.calls.legacy, 0);
    assert.ok(args.calls.kernelDeps);
    assert.notEqual(args.calls.kernelDeps, args.deps);
    assert.ok(args.calls.kernelDeps?.uokObserver);
    assert.equal(isUnifiedAuditEnabled(), true);
    assert.equal(isUnifiedAuditEnabled(basePath), false);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "uok-kernel");
    assert.equal(events[0]?.phase, "enter");
    assert.equal(events[1]?.path, "uok-kernel");
    assert.equal(events[1]?.phase, "exit");
    assert.equal(events[1]?.status, "ok");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 0);
  } finally {
    resetLegacyTelemetry();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok keeps audit disabled for legacy-wrapper while restoring process override", async () => {
  const basePath = makeBasePath();
  clearUnifiedAuditOverrideForTests();
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: false,
        audit_unified: { enabled: false },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);
    assert.equal(isUnifiedAuditEnabled(), true);
    assert.equal(isUnifiedAuditEnabled(basePath), false);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-wrapper");
    assert.equal(events[1]?.path, "legacy-wrapper");
    assert.equal(events[1]?.status, "ok");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 1);
  } finally {
    clearUnifiedAuditOverrideForTests();
    resetLegacyTelemetry();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok uses legacy path when explicit legacy fallback is enabled", async () => {
  const basePath = makeBasePath();
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        legacy_fallback: { enabled: true },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);
    assert.equal(args.calls.legacyDeps, args.deps);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-fallback");
    assert.equal(events[1]?.path, "legacy-fallback");
    assert.equal(events[1]?.status, "ok");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 1);
  } finally {
    resetLegacyTelemetry();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok respects GSD_UOK_FORCE_LEGACY emergency switch", async () => {
  const basePath = makeBasePath();
  const previous = process.env.GSD_UOK_FORCE_LEGACY;
  process.env.GSD_UOK_FORCE_LEGACY = "1";
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-fallback");
    assert.equal(events[1]?.path, "legacy-fallback");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 1);
  } finally {
    resetLegacyTelemetry();
    if (previous === undefined) delete process.env.GSD_UOK_FORCE_LEGACY;
    else process.env.GSD_UOK_FORCE_LEGACY = previous;
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok records error exit and restores previous audit override when kernel fails", async () => {
  const basePath = makeBasePath();
  clearUnifiedAuditOverrideForTests();
  setUnifiedAuditEnabled(false);
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        audit_unified: { enabled: true },
        gitops: { enabled: false },
      },
    });
    args.runKernelLoop = async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      args.calls.kernel += 1;
      args.calls.kernelDeps = loopDeps;
      throw new Error("kernel exploded");
    };

    await assert.rejects(
      () => runAutoLoopWithUok(args),
      /kernel exploded/,
    );

    assert.equal(args.calls.kernel, 1);
    assert.equal(args.calls.legacy, 0);
    assert.equal(isUnifiedAuditEnabled(), false);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.phase, "enter");
    assert.equal(events[1]?.phase, "exit");
    assert.equal(events[1]?.status, "error");
    assert.match(String(events[1]?.error), /kernel exploded/);
  } finally {
    clearUnifiedAuditOverrideForTests();
    resetLegacyTelemetry();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok treats kernel-enter audit failures as telemetry-only", async (t) => {
  const basePath = makeBasePath();
  const dbPath = join(basePath, ".gsd", "gsd.db");
  clearUnifiedAuditOverrideForTests();
  _resetLogs();
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(dbPath), true, "DB must open for this scenario");
  t.after(() => {
    clearUnifiedAuditOverrideForTests();
    closeDatabase();
    _resetLogs();
    rmSync(basePath, { recursive: true, force: true });
  });

  _getAdapter()!.exec("DROP TABLE audit_events");

  const args = makeArgs(basePath, {
    uok: {
      enabled: true,
      audit_unified: { enabled: true },
      gitops: { enabled: false },
    },
  });
  args.runKernelLoop = async (_ctx, _pi, _s, loopDeps): Promise<void> => {
    args.calls.kernel += 1;
    args.calls.kernelDeps = loopDeps;
    const observer = loopDeps.uokObserver;
    assert.ok(observer, "kernel path must still install a turn observer");
    observer.onTurnStart({
      basePath,
      traceId: "trace-audit-down",
      turnId: "turn-audit-down",
      iteration: 1,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      startedAt: new Date().toISOString(),
    });
    observer.onTurnResult({
      traceId: "trace-audit-down",
      turnId: "turn-audit-down",
      iteration: 1,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      status: "completed",
      failureClass: "none",
      phaseResults: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const gateRunner = new UokGateRunner();
    gateRunner.register({
      id: "test-gate",
      type: "policy",
      execute: async () => ({
        outcome: "pass",
        failureClass: "none",
        rationale: "ok",
      }),
    });
    await gateRunner.run("test-gate", {
      basePath,
      traceId: "trace-audit-down",
      turnId: "turn-audit-down",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });

    const filtered = applyModelPolicyFilter(
      [{ id: "model-a", provider: "openai", api: "responses" }],
      {
        basePath,
        traceId: "trace-audit-down",
        turnId: "turn-audit-down",
        unitType: "execute-task",
      },
    );
    assert.equal(filtered.eligible.length, 1);

    mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), {
      recursive: true,
    });
    writeEscalationArtifact(basePath, {
      version: 1,
      taskId: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      question: "Choose a path",
      options: [
        { id: "a", label: "A", tradeoffs: "First path" },
        { id: "b", label: "B", tradeoffs: "Second path" },
      ],
      recommendation: "a",
      recommendationRationale: "Test recommendation",
      continueWithDefault: false,
      createdAt: new Date().toISOString(),
    });
  };

  await runAutoLoopWithUok(args);

  assert.equal(args.calls.kernel, 1);
  assert.equal(args.calls.legacy, 0);

  const events = readParityEvents(basePath);
  assert.equal(events.length, 3);
  assert.equal(events[0]?.phase, "enter");
  assert.equal(events[1]?.phase, "telemetry-error");
  assert.equal(events[1]?.telemetry, "uok-kernel-enter");
  assert.equal(events[2]?.phase, "exit");
  assert.equal(events[2]?.status, "ok");
  assert.equal(isUnifiedAuditEnabled(), true);
  assert.equal(isUnifiedAuditEnabled(basePath), false);
  assert.ok(
    peekLogs().some(entry =>
      entry.severity === "warn" &&
      entry.component === "db" &&
      entry.message.includes("uok-kernel-enter audit emit failed"),
    ),
    "degraded audit path should emit a non-fatal warning",
  );

  assert.doesNotThrow(() => {
    writeEscalationArtifact(basePath, {
      version: 1,
      taskId: "T02",
      sliceId: "S01",
      milestoneId: "M001",
      question: "Continue?",
      options: [
        { id: "yes", label: "Yes", tradeoffs: "Continue" },
        { id: "no", label: "No", tradeoffs: "Stop" },
      ],
      recommendation: "yes",
      recommendationRationale: "Audit stayed disabled after degraded enter",
      continueWithDefault: true,
      createdAt: new Date().toISOString(),
    });
  });
});
