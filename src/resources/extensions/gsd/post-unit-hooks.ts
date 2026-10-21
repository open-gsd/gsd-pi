// GSD Extension — Hook Engine Facade
//
// Thin facade over RuleRegistry. All mutable state and logic lives in the
// registry instance; these exported functions delegate through getOrCreateRegistry()
// so existing call-sites and tests work without modification.

import type {
  HookExecutionState,
  HookDispatchResult,
  PreDispatchResult,
  HookStatusEntry,
  PostUnitGateBlock,
} from "./types.js";
import type { SidecarItem } from "./auto/session.js";
import {
  getOrCreateRegistry,
  resolveHookArtifactPath,
  type RetryTrigger,
} from "./rule-registry.js";

// Re-export resolveHookArtifactPath so existing importers still work.
export { resolveHookArtifactPath } from "./rule-registry.js";

// ─── Post-Unit Hooks ───────────────────────────────────────────────────────

export function checkPostUnitHooks(
  completedUnitType: string,
  completedUnitId: string,
  basePath: string,
  opts?: { blockingOnly?: boolean },
): HookDispatchResult | null {
  return getOrCreateRegistry().evaluatePostUnit(completedUnitType, completedUnitId, basePath, opts);
}

export function getActiveHook(): HookExecutionState | null {
  return getOrCreateRegistry().getActiveHook();
}

export function isRetryPending(): boolean {
  return getOrCreateRegistry().isRetryPending();
}

export function peekRetryTrigger(): RetryTrigger | null {
  return getOrCreateRegistry().peekRetryTrigger();
}

export function consumeRetryTrigger(): RetryTrigger | null {
  return getOrCreateRegistry().consumeRetryTrigger();
}

export function acknowledgeRetryTrigger(basePath: string): RetryTrigger | null {
  return getOrCreateRegistry().acknowledgeRetryTrigger(basePath);
}

export function consumeHookFailure(): { hookName: string; unitType: string; unitId: string; reason: string } | null {
  return getOrCreateRegistry().consumeHookFailure();
}

export function isGateBlockPending(): boolean {
  return getOrCreateRegistry().isGateBlockPending();
}

export function consumeGateBlock(): PostUnitGateBlock | null {
  return getOrCreateRegistry().consumeGateBlock();
}

export function resetHookState(): void {
  getOrCreateRegistry().resetState();
}

// ─── Pre-Dispatch Hooks ────────────────────────────────────────────────────

export function runPreDispatchHooks(
  unitType: string,
  unitId: string,
  prompt: string,
  basePath: string,
): PreDispatchResult {
  return getOrCreateRegistry().evaluatePreDispatch(unitType, unitId, prompt, basePath);
}

// ─── State Persistence ─────────────────────────────────────────────────────

export function persistHookState(basePath: string): void {
  getOrCreateRegistry().persistState(basePath);
}

export function restoreHookState(basePath: string): void {
  getOrCreateRegistry().restoreState(basePath);
}

/** Shared tail of the resume reconciles: enqueue a hook dispatch unless an
 *  equivalent item is already queued. */
function enqueueHookDispatch(
  dispatch: HookDispatchResult,
  sidecarQueue: SidecarItem[],
): void {
  const alreadyQueued = sidecarQueue.some(
    item => item.kind === "hook" && item.unitType === dispatch.unitType,
  );
  if (alreadyQueued) return;
  sidecarQueue.push({
    kind: "hook",
    unitType: dispatch.unitType,
    unitId: dispatch.unitId,
    prompt: dispatch.prompt,
    model: dispatch.model,
  });
}

/**
 * Reconcile a restored `activeHook` against the session's sidecar queue.
 *
 * The registry persists `activeHook` to disk but the pending hook *dispatch*
 * lives only on the non-persisted `s.sidecarQueue`. After a pause/resume or
 * crash-recovery, `restoreHookState` re-hydrates `activeHook` while the dispatch
 * is gone, so the registry believes a hook is in-flight but nothing will ever
 * complete it — and the next unrelated unit's close-out is falsely charged
 * against the stale hook and blocked. Re-enqueue the missing dispatch so the
 * hook actually runs, restoring the invariant that a persisted `activeHook`
 * always has a live dispatch (#1246).
 */
export function reconcileRestoredHookDispatch(
  basePath: string,
  sidecarQueue: SidecarItem[],
): void {
  const dispatch = getOrCreateRegistry().getPendingHookDispatch(basePath);
  if (!dispatch) return;
  enqueueHookDispatch(dispatch, sidecarQueue);
}

/**
 * Reconcile a restored gate block against the session's sidecar queue (#2194).
 *
 * A blocking gate that paused auto-mode clears `activeHook` and persists its
 * block. Without this, resume finds no hook dispatch and the next
 * `/gsd next`/`/gsd auto` can select an execute-task unit without the hook
 * passing. Re-enqueue the blocked hook so it re-runs before any unit is
 * selected; the registry re-arms it as in-flight so its completion is
 * re-assessed against the gate artifact.
 */
export function reconcileRestoredGateBlock(
  basePath: string,
  sidecarQueue: SidecarItem[],
): void {
  const dispatch = getOrCreateRegistry().reconcileRestoredGateBlock(basePath);
  if (!dispatch) return;
  enqueueHookDispatch(dispatch, sidecarQueue);
}

export function clearPersistedHookState(basePath: string): void {
  getOrCreateRegistry().clearPersistedState(basePath);
}

// ─── Status & Manual Trigger ───────────────────────────────────────────────

export function getHookStatus(): HookStatusEntry[] {
  return getOrCreateRegistry().getHookStatus();
}

export function triggerHookManually(
  hookName: string,
  unitType: string,
  unitId: string,
  basePath: string,
): HookDispatchResult | null {
  return getOrCreateRegistry().triggerHookManually(hookName, unitType, unitId, basePath);
}

export function formatHookStatus(): string {
  return getOrCreateRegistry().formatHookStatus();
}
