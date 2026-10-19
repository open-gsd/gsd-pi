// Project/App: gsd-pi
// File Purpose: ADR-017 #5707 caller-closure helper. Parent processes that
// spawn auto-loop workers must reconcile before spawn — otherwise each
// worker independently detects+repairs the same drift, racing on shared
// state. This helper centralises the reconcile+catch flow so the two
// production spawn sites (commands/handlers/parallel.ts and auto/phases.ts
// startSliceParallel) share one contract.

import {
  reconcileBeforeDispatch,
  ReconciliationFailedError,
  type ReconciliationDeps,
} from "./index.js";
import { preserveProjectionEvidence } from "../projection-observation.js";
import {
  describeHeldProjectionChanges,
  describePreservedProjectionChanges,
  preserveProjectionChangesBeforeDispatch,
  repairProjectionDrift,
} from "../projection-worker.js";
import { logWarning } from "../workflow-logger.js";

export type SpawnGateResult =
  | { ok: true; reason?: string }
  | { ok: false; reason: string };

export interface SpawnGateDeps extends Partial<ReconciliationDeps> {
  reconcile?: typeof reconcileBeforeDispatch;
}

/**
 * Run reconciliation before spawning workers. Returns ok=true only when the run
 * completed without throwing AND surfaced no blockers; any blocker fails the
 * gate (ok=false, reason carries the first blocker) so callers must not spawn.
 * On ReconciliationFailedError, returns ok=false with the error message so the
 * caller can surface it to the user without re-throwing.
 *
 * Other unexpected errors propagate; they are not part of the drift
 * taxonomy. Projection files are not workflow state: a changed, missing or
 * unreadable projection is preserved, rendered again and reported, and never
 * fails the gate. The one exception is a changed git-tracked projection, which
 * is held for a user choice.
 */
export async function reconcileBeforeSpawn(
  basePath: string,
  deps: SpawnGateDeps = {},
): Promise<SpawnGateResult> {
  const { reconcile, ...reconcileDeps } = deps;
  const reconcileFn = reconcile ?? reconcileBeforeDispatch;
  const hasReconcileDeps = Object.keys(reconcileDeps).length > 0;
  try {
    const notes: string[] = [];
    try {
      const observation = await preserveProjectionChangesBeforeDispatch(basePath);
      if (observation.held.length > 0) {
        return { ok: false, reason: describeHeldProjectionChanges(basePath, observation.held) };
      }
      if (observation.preserved.length > 0) {
        notes.push(describePreservedProjectionChanges(basePath, observation.preserved));
      }
      for (const error of observation.errors) logWarning("projection", `projection render failed: ${error}`);
    } catch (error) {
      logWarning("reconcile", `Projection observation failed: ${(error as Error).message}`);
    }
    const result = await reconcileFn(
      basePath,
      hasReconcileDeps ? (reconcileDeps as ReconciliationDeps) : undefined,
    );
    if (result.blockers.length > 0) {
      return {
        ok: false,
        reason: `Reconciliation blocker: ${result.blockers[0]}`,
      };
    }
    // After reconciliation, so the layout is settled before files are compared.
    const drift = await repairProjectionDrift(basePath);
    for (const error of drift.errors) logWarning("projection", `projection drift repair failed: ${error}`);
    const repairedKinds = [...result.repaired, ...drift.repaired].map((d) => d.kind);
    if (repairedKinds.length > 0) notes.unshift(`repaired before spawn: ${repairedKinds.join(", ")}`);
    return {
      ok: true,
      reason: notes.length > 0 ? notes.join("\n") : undefined,
    };
  } catch (err) {
    if (err instanceof ReconciliationFailedError) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }
}

/**
 * Read-only form of the pre-dispatch hold, for a dispatch that does not run
 * reconciliation (guided flow and /gsd dispatch). Returns the "changed outside
 * GSD" reason when a changed git-tracked projection must stop the dispatch,
 * else null. Nothing is moved or rendered, so a hand edit of an untracked
 * projection stays as it is.
 */
export async function heldProjectionChangesBeforeDispatch(basePath: string): Promise<string | null> {
  try {
    const { held } = await preserveProjectionEvidence(basePath, [], true, true);
    return held.length > 0 ? describeHeldProjectionChanges(basePath, held) : null;
  } catch (error) {
    // Projection files are not workflow state: report the failure and go on.
    logWarning("reconcile", `Projection observation failed: ${(error as Error).message}`);
    return null;
  }
}
