// Project/App: gsd-pi
// File Purpose: Selects the UOK kernel path and runs the auto loop on it.
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AutoSession } from "../auto/session.js";
import type { LoopDeps } from "../auto/loop-deps.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";
import {
  getUnifiedAuditOverride,
  restoreUnifiedAuditOverride,
  setUnifiedAuditEnabled,
  setUnifiedAuditSuppressedForBasePath,
} from "./audit-toggle.js";
import { resolveUokFlags, type UokFlags } from "./flags.js";
import { createTurnObserver } from "./loop-adapter.js";
import { incrementLegacyTelemetry } from "../legacy-telemetry.js";
import { logWarning } from "../workflow-logger.js";
import { withGlobalIdleWatchdog } from "../auto-timers.js";

interface RunAutoLoopWithUokArgs {
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
}

type UokKernelPathLabel = "uok-kernel" | "legacy-wrapper" | "legacy-fallback";

interface UokKernelRunPlan {
  flags: UokFlags;
  pathLabel: UokKernelPathLabel;
  traceId: string;
  useKernel: boolean;
}

function resolveKernelPathLabel(
  flags: UokFlags,
): UokKernelPathLabel {
  if (flags.legacyFallback) return "legacy-fallback";
  return flags.enabled ? "uok-kernel" : "legacy-wrapper";
}

function createUokKernelRunPlan(input: {
  preferences: ReturnType<LoopDeps["loadEffectiveGSDPreferences"]> | undefined;
  autoStartTime?: unknown;
}): UokKernelRunPlan {
  const flags = resolveUokFlags(input.preferences?.preferences);
  const pathLabel = resolveKernelPathLabel(flags);
  return {
    flags,
    pathLabel,
    traceId: `session:${String(input.autoStartTime || Date.now())}`,
    useKernel: flags.enabled,
  };
}

interface KernelAuditStateController {
  apply(enabled: boolean): void;
  restore(): void;
}

function createKernelAuditStateController(basePath: string): KernelAuditStateController {
  const previousAuditOverride = getUnifiedAuditOverride();
  return {
    apply(enabled): void {
      setUnifiedAuditSuppressedForBasePath(basePath, !enabled);
      setUnifiedAuditEnabled(enabled);
    },
    restore(): void {
      restoreUnifiedAuditOverride(previousAuditOverride);
    },
  };
}

function emitKernelEnterAudit(input: {
  basePath: string;
  plan: UokKernelRunPlan;
  sessionId?: string;
}): boolean {
  if (!input.plan.flags.auditUnified) return true;

  try {
    emitUokAuditEvent(
      input.basePath,
      buildAuditEnvelope({
        traceId: input.plan.traceId,
        category: "orchestration",
        type: "uok-kernel-enter",
        payload: {
          flags: input.plan.flags,
          sessionId: input.sessionId,
        },
      }),
    );
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logWarning("db", `uok-kernel-enter audit emit failed (non-fatal): ${errorMessage}`);
    return false;
  }
}

function decorateLoopDepsForKernel(input: {
  deps: LoopDeps;
  basePath: string;
  plan: UokKernelRunPlan;
  auditHealthy: boolean;
}): LoopDeps {
  if (!input.plan.useKernel) return input.deps;

  return {
    ...input.deps,
    uokObserver: createTurnObserver({
      basePath: input.basePath,
      gitAction: input.plan.flags.gitopsTurnAction,
      gitPush: input.plan.flags.gitopsTurnPush,
      enableAudit: input.plan.flags.auditUnified && input.auditHealthy,
      enableGitops: input.plan.flags.gitops,
    }),
  };
}

async function executeKernelRunPlan(input: {
  plan: UokKernelRunPlan;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  s: AutoSession;
  deps: LoopDeps;
  kernelDeps: LoopDeps;
  runKernelLoop: RunAutoLoopWithUokArgs["runKernelLoop"];
  runLegacyLoop: RunAutoLoopWithUokArgs["runLegacyLoop"];
}): Promise<void> {
  if (input.plan.useKernel) {
    await input.runKernelLoop(input.ctx, input.pi, input.s, input.kernelDeps);
    return;
  }
  await input.runLegacyLoop(input.ctx, input.pi, input.s, input.deps);
}

export async function runAutoLoopWithUok(args: RunAutoLoopWithUokArgs): Promise<void> {
  const { ctx, pi, s, deps, runKernelLoop, runLegacyLoop } = args;
  const auditState = createKernelAuditStateController(s.basePath);
  let plan: UokKernelRunPlan | null = null;

  try {
    plan = createUokKernelRunPlan({
      preferences: deps.loadEffectiveGSDPreferences(),
      autoStartTime: s.autoStartTime,
    });
    auditState.apply(plan.flags.auditUnified);

    if (plan.pathLabel !== "uok-kernel") {
      incrementLegacyTelemetry("legacy.uokFallbackUsed");
    }

    const auditHealthy = emitKernelEnterAudit({
      basePath: s.basePath,
      plan,
      sessionId: ctx.sessionManager?.getSessionId?.(),
    });
    auditState.apply(plan.flags.auditUnified && auditHealthy);

    const kernelDeps = decorateLoopDepsForKernel({
      deps,
      basePath: s.basePath,
      plan,
      auditHealthy,
    });

    // The session-level idle watchdog (#2373) lives above whichever loop path
    // runs: it observes unit presence across the whole loop run and is cleared
    // when the loop promise settles. Disabled by default (global 0).
    const resolvedPlan = plan;
    await withGlobalIdleWatchdog(ctx, s, () =>
      executeKernelRunPlan({
        plan: resolvedPlan,
        ctx,
        pi,
        s,
        deps,
        kernelDeps,
        runKernelLoop,
        runLegacyLoop,
      }),
    );
  } finally {
    auditState.restore();
  }
}
