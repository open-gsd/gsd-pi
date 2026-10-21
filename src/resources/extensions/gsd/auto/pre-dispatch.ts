// Project/App: gsd-pi
// File Purpose: Auto-loop pre-dispatch phase.

import { join } from "node:path";
import { existsSync, cpSync } from "node:fs";
import { basename } from "node:path";
import { UokGateRunner } from "../uok/gate-runner.js";
import { resolveUokFlags } from "../uok/flags.js";
import {
  ensurePlanV2Graph,
  isEmptyPlanV2GraphResult,
  isMissingFinalizedContextResult,
} from "../uok/plan-v2.js";
import { getEligibleSlices } from "../slice-parallel-eligibility.js";
import { isSliceParallelActive, startSliceParallel } from "../slice-parallel-orchestrator.js";
import { reconcileBeforeSpawn } from "../state-reconciliation.js";
import {
  countUnmappedActiveRequirements,
  formatCompletePhaseNextAction,
} from "../requirements-backlog.js";
import { isDbAvailable, getMilestoneSlices } from "../gsd-db.js";
import { getIsolationMode } from "../preferences.js";
import { gsdRoot } from "../paths.js";
import { atomicWriteSync } from "../atomic-write.js";
import { logWarning } from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import {
  _resolveDispatchGuardBasePath,
  shouldRunPlanV2Gate,
  isSamePathLocal,
} from "./phase-helpers.js";
import {
  closeoutAndStop,
  generateMilestoneReport,
  _runMilestoneMergeOnceWithStashRestore,
  shouldSkipTerminalMilestoneCloseout,
} from "./closeout.js";
import type { IterationContext, LoopState, PhaseResult, PreDispatchData } from "./types.js";

type BlockerKind = "needs-remediation-dead-end" | "completed-milestone-reopened" | "other";

function classifyBlocker(blocker: string): BlockerKind {
  const normalized = blocker.toLowerCase();
  if (normalized.includes("needs-remediation") && normalized.includes("all slices are complete")) {
    return "needs-remediation-dead-end";
  }
  if (
    normalized.includes("completed closeout dispatch history") ||
    normalized.includes("completed complete-milestone dispatch history")
  ) {
    return "completed-milestone-reopened";
  }
  return "other";
}

function sanitizeBlockerForUser(blocker: string): string {
  return blocker.replaceAll("gsd_reassess_roadmap", "/gsd dispatch reassess");
}

/**
 * Formats blocked resume guidance for users, ensuring internal tool names are
 * never surfaced in notification text.
 */
function formatBlockedResumeMessage(blockers: string[]): string {
  const classifiedBlockers = blockers.map((blocker) => ({
    blocker: sanitizeBlockerForUser(blocker),
    kind: classifyBlocker(blocker),
  }));
  const hasNeedsRemediationDeadEnd = classifiedBlockers.some(
    (classifiedBlocker) => classifiedBlocker.kind === "needs-remediation-dead-end"
  );
  if (hasNeedsRemediationDeadEnd) {
    return "Blocked: milestone validation requires remediation but all slices are complete. Run /gsd dispatch reassess to add remediation slices, then /gsd auto to continue.";
  }
  const completedMilestoneReopened = classifiedBlockers.find(
    (classifiedBlocker) => classifiedBlocker.kind === "completed-milestone-reopened",
  );
  if (completedMilestoneReopened) {
    return completedMilestoneReopened.blocker;
  }
  return `Blocked: ${classifiedBlockers.map((classifiedBlocker) => classifiedBlocker.blocker).join(", ")}. Fix and run /gsd auto to resume.`;
}

/**
 * Phase 1: Pre-dispatch — resource guard, health gate, state derivation,
 * milestone transition, terminal conditions.
 * Returns break to exit the loop, or next with PreDispatchData on success.
 */
export async function runPreDispatch(
  ic: IterationContext,
  loopState: LoopState,
): Promise<PhaseResult<PreDispatchData>> {
  const { ctx, pi, s, deps, prefs } = ic;
  const uokFlags = resolveUokFlags(prefs);
  const runPreDispatchGate = async (input: {
    gateId: string;
    gateType: string;
    outcome: "pass" | "fail" | "retry" | "manual-attention";
    failureClass: "none" | "policy" | "input" | "execution" | "artifact" | "verification" | "closeout" | "git" | "timeout" | "manual-attention" | "unknown";
    rationale: string;
    findings?: string;
    milestoneId?: string;
  }): Promise<void> => {
    if (!uokFlags.gates) return;
    const gateRunner = new UokGateRunner();
    gateRunner.register({
      id: input.gateId,
      type: input.gateType,
      execute: async () => ({
        outcome: input.outcome,
        failureClass: input.failureClass,
        rationale: input.rationale,
        findings: input.findings ?? "",
      }),
    });
    await gateRunner.run(input.gateId, {
      basePath: s.basePath,
      traceId: `pre-dispatch:${ic.flowId}`,
      turnId: `iter-${ic.iteration}`,
      milestoneId: input.milestoneId ?? s.currentMilestoneId ?? undefined,
      unitType: "pre-dispatch",
      unitId: `iter-${ic.iteration}`,
    });
  };

  // Resource version guard
  const staleMsg = deps.checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await runPreDispatchGate({
      gateId: "resource-version-guard",
      gateType: "policy",
      outcome: "fail",
      failureClass: "policy",
      rationale: "resource version guard blocked dispatch",
      findings: staleMsg,
    });
    await deps.stopAuto(ctx, pi, staleMsg);
    debugLog("autoLoop", { phase: "exit", reason: "resources-stale" });
    return { action: "break", reason: "resources-stale" };
  }
  await runPreDispatchGate({
    gateId: "resource-version-guard",
    gateType: "policy",
    outcome: "pass",
    failureClass: "none",
    rationale: "resource version guard passed",
  });

  deps.invalidateAllCaches();
  s.lastPromptCharCount = undefined;
  s.lastBaselineCharCount = undefined;

  // Pre-dispatch health gate
  try {
    const expectedCurrentUnit = null;
    const healthGate = await deps.preDispatchHealthGate(s.basePath);
    if (healthGate.fixesApplied.length > 0) {
      ctx.ui.notify(
        `Pre-dispatch: ${healthGate.fixesApplied.join(", ")}`,
        "info",
      );
    }
    if (!healthGate.proceed) {
      await runPreDispatchGate({
        gateId: "pre-dispatch-health-gate",
        gateType: "execution",
        outcome: "manual-attention",
        failureClass: "manual-attention",
        rationale: "pre-dispatch health gate blocked dispatch",
        findings: healthGate.reason,
      });
      ctx.ui.notify(
        healthGate.reason || "Pre-dispatch health check failed — run /gsd doctor for details.",
        "error",
      );
      await deps.pauseAuto(ctx, pi, undefined, { expectedCurrentUnit });
      debugLog("autoLoop", { phase: "exit", reason: "health-gate-failed" });
      return { action: "break", reason: "health-gate-failed" };
    }
    await runPreDispatchGate({
      gateId: "pre-dispatch-health-gate",
      gateType: "execution",
      outcome: "pass",
      failureClass: "none",
      rationale: "pre-dispatch health gate passed",
      findings: healthGate.fixesApplied.length > 0 ? healthGate.fixesApplied.join(", ") : "",
    });
  } catch (e) {
    await runPreDispatchGate({
      gateId: "pre-dispatch-health-gate",
      gateType: "execution",
      outcome: "manual-attention",
      failureClass: "manual-attention",
      rationale: "pre-dispatch health gate threw unexpectedly",
      findings: String(e),
    });
    logWarning("engine", "Pre-dispatch health gate threw unexpectedly", { error: String(e) });
  }

  // Sync project root artifacts into worktree
  if (
    s.originalBasePath &&
    !isSamePathLocal(s.basePath, s.originalBasePath) &&
    s.currentMilestoneId &&
    s.scope
  ) {
    deps.worktreeProjection.projectRootToWorktree(s.scope);
  }

  // Derive state — use canonical project root so the cache key is stable
  // across worktree↔project-root path-form alternation. See PR #5236
  // (workspace handle infrastructure) and the Phase A pt 2 plan.
  let state = await deps.deriveState(s.canonicalProjectRoot);
  const { getDeepStageGate } = await import("../auto-dispatch.js");
  const deepStageGate = getDeepStageGate(prefs, s.basePath);
  const canRunDeepSetupGate =
    state.phase === "pre-planning" ||
    state.phase === "needs-discussion" ||
    state.phase === "planning";
  if (
    canRunDeepSetupGate &&
    (deepStageGate.status === "pending" || deepStageGate.status === "blocked")
  ) {
    debugLog("autoLoop", {
      phase: "deep-project-stage-gate",
      stage: deepStageGate.stage,
      status: deepStageGate.status,
      reason: deepStageGate.reason,
    });
    return {
      action: "next",
      data: {
        state: {
          ...state,
          phase: "pre-planning",
          activeMilestone: null,
          activeSlice: null,
          activeTask: null,
          nextAction: deepStageGate.reason,
        },
        mid: "PROJECT",
        midTitle: "Project setup",
      },
    };
  }

  if (uokFlags.planV2 && shouldRunPlanV2Gate(state.phase)) {
    let compiled = ensurePlanV2Graph(s.basePath, state);
    if (isEmptyPlanV2GraphResult(compiled)) {
      deps.invalidateAllCaches();
      state = await deps.deriveState(s.canonicalProjectRoot);
      compiled = shouldRunPlanV2Gate(state.phase)
        ? ensurePlanV2Graph(s.basePath, state)
        : {
            ok: true,
            reason: "empty plan-v2 graph recovered by state rederive",
            nodeCount: 0,
          };
    }
    if (!compiled.ok) {
      const reason = compiled.reason ?? "Plan v2 compilation failed";
      if (isMissingFinalizedContextResult(compiled)) {
        await runPreDispatchGate({
          gateId: "plan-v2-gate",
          gateType: "policy",
          outcome: "pass",
          failureClass: "none",
          rationale: "plan v2 missing context recovery deferred to dispatch",
          findings: reason,
          milestoneId: state.activeMilestone?.id ?? undefined,
        });
      } else {
        await runPreDispatchGate({
          gateId: "plan-v2-gate",
          gateType: "policy",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "plan v2 compile gate failed",
          findings: reason,
          milestoneId: state.activeMilestone?.id ?? undefined,
        });
        ctx.ui.notify(`Plan gate failed-closed: ${reason}\n\nIf this keeps happening, try: /gsd doctor heal`, "error");
        await deps.pauseAuto(ctx, pi);
        return { action: "break", reason: "plan-v2-gate-failed" };
      }
    }
    if (compiled.ok) {
      await runPreDispatchGate({
        gateId: "plan-v2-gate",
        gateType: "policy",
        outcome: "pass",
        failureClass: "none",
        rationale: "plan v2 compile gate passed",
        milestoneId: state.activeMilestone?.id ?? undefined,
      });
    }
  }
  deps.syncCmuxSidebar(prefs, state);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;
  debugLog("autoLoop", {
    phase: "state-derived",
    iteration: ic.iteration,
    mid,
    statePhase: state.phase,
  });

  // ── Slice-level parallelism gate (#2340) ─────────────────────────────
  // When slice_parallel is enabled, check if multiple slices are eligible
  // for parallel execution. If so, dispatch them in parallel and stop the
  // sequential loop. Workers are spawned via slice-parallel-orchestrator.ts.
  if (
    prefs?.slice_parallel?.enabled &&
    mid &&
    !process.env.GSD_PARALLEL_WORKER &&
    isDbAvailable()
  ) {
    try {
      const projectRoot = _resolveDispatchGuardBasePath(s);
      if (isSliceParallelActive(projectRoot)) {
        ctx.ui.notify("Slice-parallel: workers are still running; waiting for completion before next dispatch.", "info");
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        return { action: "continue" };
      }
      const dbSlices = getMilestoneSlices(mid);
      if (dbSlices.length > 0) {
        const doneIds = new Set(dbSlices.filter(sl => sl.status === "complete" || sl.status === "done").map(sl => sl.id));
        const sliceInputs = dbSlices.map(sl => ({
          id: sl.id,
          done: doneIds.has(sl.id),
          depends: sl.depends ?? [],
        }));
        const eligible = getEligibleSlices(sliceInputs, doneIds);
        if (eligible.length > 1) {
          debugLog("autoLoop", {
            phase: "slice-parallel-dispatch",
            iteration: ic.iteration,
            mid,
            eligibleSlices: eligible.map(e => e.id),
          });
          ctx.ui.notify(
            `Slice-parallel: dispatching ${eligible.length} eligible slices for ${mid}.`,
            "info",
          );
          // ADR-017 #5707: reconcile before spawning so each worker doesn't
          // independently race on the same drift. Failure aborts the spawn.
          const spawnGate = await reconcileBeforeSpawn(projectRoot);
          if (!spawnGate.ok) {
            ctx.ui.notify(
              `Slice-parallel: aborting spawn — ${spawnGate.reason}`,
              "error",
            );
            return { action: "break", reason: `slice-parallel-reconciliation-failed: ${spawnGate.reason}` };
          }
          const result = await startSliceParallel(
            projectRoot,
            mid,
            eligible,
            {
              maxWorkers: prefs.slice_parallel.max_workers ?? 2,
              useExecutionGraph: uokFlags.executionGraph,
            },
          );
          if (result.started.length > 0) {
            ctx.ui.notify(
              `Slice-parallel: started ${result.started.length} worker(s): ${result.started.join(", ")}.`,
              "info",
            );
            return { action: "continue" };
          }
          if (result.errors.length > 0) {
            const detail = result.errors
              .map((err) => `${err.sid}: ${err.error}`)
              .join("; ");
            ctx.ui.notify(
              `Slice-parallel startup failed; falling back to sequential execution. ${detail}`,
              "warning",
            );
          }
          // Fall through to sequential if no workers started
        }
      }
    } catch (err) {
      debugLog("autoLoop", {
        phase: "slice-parallel-check-error",
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — fall through to sequential dispatch
    }
  }

  // ── Milestone transition ────────────────────────────────────────────
  if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "milestone-transition", data: { from: s.currentMilestoneId, to: mid } });
    ctx.ui.notify(
      `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
      "info",
    );
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${s.currentMilestoneId} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath),
    );
    deps.logCmuxEvent(
      prefs,
      `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}.`,
      "success",
    );

    const vizPrefs = prefs;
    if (vizPrefs?.auto_visualize) {
      ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
    }
    if (vizPrefs?.auto_report !== false) {
      try {
        await generateMilestoneReport(s, ctx, s.currentMilestoneId!);
      } catch (err) {
        ctx.ui.notify(
          `Report generation failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }

    // Reset dispatch counters for new milestone
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
    s.unitLifetimeDispatches.clear();

    // Worktree lifecycle on milestone transition — merge current, enter next.
    // #2909 / #5538-followup: preflight stash + always-on postflight pop.
    {
      const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId!);
      if (stop) return stop;
    }

    // PR creation (auto_pr) is handled by the publication handoff in
    // the milestone merge transaction (#2302).

    deps.invalidateAllCaches();

    state = await deps.deriveState(s.canonicalProjectRoot);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;

    if (mid) {
      if (deps.getIsolationMode(s.basePath) !== "none") {
        deps.captureIntegrationBranch(s.basePath, mid);
      }
      const enterResult = deps.lifecycle.enterMilestone(mid, ctx.ui);
      if (!enterResult.ok) {
        ctx.ui.notify(
          `Milestone transition stopped: failed to enter ${mid} (${enterResult.reason}).`,
          "error",
        );
        if (enterResult.reason === "lease-conflict") {
          await deps.pauseAuto(ctx, pi);
        }
        return { action: "break", reason: "milestone-enter-failed" };
      }
    } else {
      // mid is undefined — no milestone to capture integration branch for
    }

    const pendingIds = state.registry
      .filter(
        (m: { status: string }) =>
          m.status !== "complete" && m.status !== "parked",
      )
      .map((m: { id: string }) => m.id);
    deps.pruneQueueOrder(s.basePath, pendingIds);

    // Archive the old completed-units.json instead of wiping it (#2313).
    try {
      const completedKeysPath = join(gsdRoot(s.basePath), "completed-units.json");
      if (existsSync(completedKeysPath) && s.currentMilestoneId) {
        const archivePath = join(
          gsdRoot(s.basePath),
          `completed-units-${s.currentMilestoneId}.json`,
        );
        cpSync(completedKeysPath, archivePath);
      }
      atomicWriteSync(completedKeysPath, JSON.stringify([], null, 2));
    } catch (e) {
      logWarning("engine", "Failed to archive completed-units on milestone transition", { error: String(e) });
    }

    // Rebuild STATE.md immediately so it reflects the new active milestone.
    // This bypasses the 30-second throttle in the normal rebuild path —
    // milestone transitions are rare and important enough to warrant an
    // immediate write.
    try {
      await deps.rebuildState(s.basePath);
    } catch (e) {
      logWarning("engine", "STATE.md rebuild failed after milestone transition", { error: String(e) });
    }

    // Re-project ROADMAP/PLAN markdown from the authoritative DB. Worktree DB
    // reconciliation during merge can leave main-branch markdown stale relative
    // to gsd.db (the 3M/3S/10T vs 3M/5S/16T drift class at /gsd startup).
    try {
      const { rebuildMarkdownProjectionsFromDb } = await import("../commands-maintenance.js");
      await rebuildMarkdownProjectionsFromDb(s.canonicalProjectRoot);
      if (s.basePath !== s.canonicalProjectRoot) {
        await rebuildMarkdownProjectionsFromDb(s.basePath);
      }
    } catch (e) {
      logWarning("engine", "markdown projection rebuild failed after milestone transition", { error: String(e) });
    }
  }

  if (mid) {
    s.currentMilestoneId = mid;
    deps.setActiveMilestoneId(s.basePath, mid);
  }

  // ── Terminal conditions ──────────────────────────────────────────────

  if (state.phase === "complete") {
    const closeoutSkip = await shouldSkipTerminalMilestoneCloseout(s, state, mid);
    if (closeoutSkip.skip) {
      debugLog("autoLoop", { phase: "complete", reason: "milestone-already-closed", milestoneId: closeoutSkip.milestoneId });
      return { action: "break", reason: "milestone-complete" };
    }
  }

  if (!mid) {
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
      );
    }

    const incomplete = state.registry.filter(
      (m: { status: string }) =>
        m.status !== "complete" && m.status !== "parked",
    );
    if (incomplete.length === 0 && state.registry.length > 0) {
      // All milestones complete — merge milestone branch before stopping.
      if (s.currentMilestoneId) {
        // #2909 / #5538-followup: preflight stash + always-on postflight pop.
        const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId);
        if (stop) return stop;
        // PR creation (auto_pr) is handled by the publication handoff in
        // the milestone merge transaction (#2302).
      }
      const unmappedActive = countUnmappedActiveRequirements();
      const completionStopReason = formatCompletePhaseNextAction(unmappedActive);
      deps.sendDesktopNotification(
        "GSD",
        unmappedActive > 0 ? "All milestones complete — requirements backlog remains" : "All milestones complete!",
        "success",
        "milestone",
        basename(s.originalBasePath || s.basePath),
      );
      deps.logCmuxEvent(
        prefs,
        completionStopReason,
        "success",
      );
      await deps.stopAuto(ctx, pi, completionStopReason, {
        completionWidget: {
          milestoneId: s.currentMilestoneId,
          milestoneTitle: midTitle,
          allMilestonesComplete: true,
        },
      });
    } else if (incomplete.length === 0 && state.registry.length === 0) {
      // Empty registry — no milestones visible, likely a path resolution bug
      const diag = `basePath=${s.basePath}, phase=${state.phase}`;
      ctx.ui.notify(
        `No milestones visible in current scope. Possible path resolution issue.\n   Diagnostic: ${diag}`,
        "error",
      );
      await deps.stopAuto(
        ctx,
        pi,
        `No milestones found — check basePath resolution`,
      );
    } else if (state.phase === "blocked") {
      const blockedResumeMessage = formatBlockedResumeMessage(state.blockers);
      // Pause instead of hard-stop so the session is resumable with `/gsd auto`.
      // Hard-stop here was causing premature termination when slice dependencies
      // were temporarily unresolvable (e.g. after reassessment added new slices).
      await deps.pauseAuto(ctx, pi);
      ctx.ui.notify(blockedResumeMessage, "warning");
      deps.sendDesktopNotification("GSD", blockedResumeMessage, "warning", "attention", basename(s.originalBasePath || s.basePath));
      deps.logCmuxEvent(prefs, blockedResumeMessage, "warning");
    } else {
      const ids = incomplete.map((m: { id: string }) => m.id).join(", ");
      const diag = `basePath=${s.basePath}, milestones=[${state.registry.map((m: { id: string; status: string }) => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
      ctx.ui.notify(
        `Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.\n   Diagnostic: ${diag}`,
        "error",
      );
      await deps.stopAuto(
        ctx,
        pi,
        `No active milestone — ${incomplete.length} incomplete (${ids}), see diagnostic above`,
      );
    }
    debugLog("autoLoop", { phase: "exit", reason: "no-active-milestone" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "no-active-milestone" } });
    return { action: "break", reason: "no-active-milestone" };
  }

  if (!midTitle) {
    midTitle = mid;
    ctx.ui.notify(
      `Milestone ${mid} has no title in roadmap — using ID as fallback.`,
      "warning",
    );
  }

  // Mid-merge safety check
  const mergeReconcileResult = deps.reconcileMergeState(s.basePath, ctx);
  if (mergeReconcileResult === "blocked") {
    await deps.pauseAuto(ctx, pi);
    debugLog("autoLoop", { phase: "exit", reason: "merge-reconciliation-blocked" });
    return { action: "break", reason: "merge-reconciliation-blocked" };
  }
  if (mergeReconcileResult === "reconciled") {
    deps.invalidateAllCaches();
    state = await deps.deriveState(s.canonicalProjectRoot);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }

  if (!mid || !midTitle) {
    const noMilestoneReason = !mid
      ? "No active milestone after merge reconciliation"
      : `Milestone ${mid} has no title after reconciliation`;
    await closeoutAndStop(ctx, pi, s, deps, noMilestoneReason);
    debugLog("autoLoop", {
      phase: "exit",
      reason: "no-milestone-after-reconciliation",
    });
    return { action: "break", reason: "no-milestone-after-reconciliation" };
  }

  // Terminal: complete
  if (state.phase === "complete") {
    // Milestone merge on complete (before closeout so branch state is clean).
    if (s.currentMilestoneId) {
      // #2909 / #5538-followup: preflight stash + always-on postflight pop.
      const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId);
      if (stop) return stop;
      // PR creation (auto_pr) is handled by the publication handoff in
      // the milestone merge transaction (#2302).
    }
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${mid} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath),
    );
    deps.logCmuxEvent(
      prefs,
      `Milestone ${mid} complete.`,
      "success",
    );
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
      );
      s.clearCurrentUnit();
    }
    await deps.stopAuto(ctx, pi, `Milestone ${mid} complete`, {
      completionWidget: {
        milestoneId: mid,
        milestoneTitle: midTitle,
      },
    });
    debugLog("autoLoop", { phase: "exit", reason: "milestone-complete" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "milestone-complete", milestoneId: mid } });
    return { action: "break", reason: "milestone-complete" };
  }

  // Terminal: blocked — pause instead of hard-stop so the session is resumable.
  if (state.phase === "blocked") {
    const blockedResumeMessage = formatBlockedResumeMessage(state.blockers);
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id),
      );
    }
    await deps.pauseAuto(ctx, pi);
    ctx.ui.notify(blockedResumeMessage, "warning");
    deps.sendDesktopNotification("GSD", blockedResumeMessage, "warning", "attention", basename(s.originalBasePath || s.basePath));
    deps.logCmuxEvent(prefs, blockedResumeMessage, "warning");
    debugLog("autoLoop", { phase: "exit", reason: "blocked" });
    deps.emitJournalEvent({ ts: new Date().toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "blocked", blockers: state.blockers } });
    return { action: "break", reason: "blocked" };
  }

  return { action: "next", data: { state, mid, midTitle } };
}
