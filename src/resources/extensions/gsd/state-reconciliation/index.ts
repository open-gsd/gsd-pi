// Project/App: gsd-pi
// File Purpose: ADR-017 drift-driven State Reconciliation Module entry point.
// reconcileBeforeDispatch runs before every Dispatch decision and worker spawn.

import {
  deriveState as defaultDeriveState,
  invalidateStateCache as defaultInvalidate,
} from "../state.js";
import { clearParseCache as defaultClearParseCache } from "../files.js";
import { clearPathCache } from "../paths.js";
import { resolveWorktreeOwningProjectRoot } from "../worktree-root.js";
import { logWarning } from "../workflow-logger.js";
import type { GSDState } from "../types.js";

import {
  ReconciliationFailedError,
  type ReconciliationFailureDetail,
} from "./errors.js";
import { DRIFT_REGISTRY, RECONCILIATION_REPAIR_PHASES, type ReconciliationRepairPhase } from "./registry.js";
import type {
  DriftContext,
  DriftHandler,
  DriftRecord,
  ReconciliationBlockerDetail,
  ReconciliationDeps,
  ReconciliationResult,
} from "./types.js";

export type {
  DriftContext,
  DriftHandler,
  DriftRecord,
  ReconciliationDeps,
  ReconciliationResult,
  ReconciliationBlockerDetail,
} from "./types.js";
export { ReconciliationFailedError } from "./errors.js";
export type { ReconciliationFailureDetail } from "./errors.js";
export { DRIFT_REGISTRY, RECONCILIATION_REPAIR_PHASES, handlerPhaseIndex } from "./registry.js";

const MAX_PASSES = 2;

const defaultDeps: ReconciliationDeps = {
  invalidateStateCache: defaultInvalidate,
  deriveState: defaultDeriveState,
  clearParseCache: defaultClearParseCache,
};

function dedupeBlockerDetails(
  details: readonly ReconciliationBlockerDetail[],
): ReconciliationBlockerDetail[] {
  const seen = new Set<string>();
  return details.filter((detail) => {
    const key = JSON.stringify(detail);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stateBlockerDetails(state: GSDState): ReconciliationBlockerDetail[] {
  return (state.blockers ?? []).map((message) => ({ message }));
}

/**
 * Drift-driven pre-dispatch reconciliation per ADR-017.
 *
 * Before non-dry-run detection, settles a pending flat-phase migration when
 * the workflow DB is available and clears layout caches after a migration.
 * Dry-run leaves migration state untouched.
 *
 * Repair lifecycle: derive → detect drift → apply repairs → re-derive.
 * Capped at MAX_PASSES (=2) cycles. The loop runs only when the prior pass fully
 * succeeded but re-derive surfaces NEW drift (cascading repairs — e.g.
 * fixing milestone registration uncovers a downstream completion-timestamp
 * drift).
 *
 * Returns ok=true with `repaired` and terminal `blockers` populated.
 * Throws ReconciliationFailedError when:
 *   - any repair function throws within a pass, or
 *   - drift persists after the cap.
 */
export async function reconcileBeforeDispatch(
  basePath: string,
  partialDeps: Partial<ReconciliationDeps> = {},
): Promise<ReconciliationResult> {
  const deps: ReconciliationDeps = { ...defaultDeps, ...partialDeps };
  const registry = deps.registry ?? DRIFT_REGISTRY;
  const repairPhases = getRepairPhases(registry);
  const clearParseCache = deps.clearParseCache ?? defaultClearParseCache;
  const repaired: DriftRecord[] = [];

  if (!deps.dryRun) {
    // Startup race (#1774): session_start's flat-phase migration (legacy
    // .gsd/milestones/ → .gsd/phases/) may still be pending or in flight — in
    // this process or a sibling headless process — when the first dispatch
    // reconciles. Detectors then see the transient mid-move gap (projection in
    // neither layout → phantom roadmap-missing drift), and a repair write into
    // the legacy tree dies with ENOENT when the migration renames it
    // mid-write, permanently wedging auto-mode. migrateToFlatPhase is
    // idempotent and serialized by a cross-process lock, so awaiting it here
    // settles the layout exactly once; afterwards this is a cheap readdir.
    // Gated on !dryRun to keep detection read-only and on isDbAvailable
    // because the migration renders from DB rows.
    const { isDbAvailable } = await import("../gsd-db.js");
    if (isDbAvailable()) {
      const { needsFlatPhaseMigration, migrateToFlatPhase } = await import("../flat-phase-migration.js");
      const migrationBasePath = resolveWorktreeOwningProjectRoot(basePath);
      if (needsFlatPhaseMigration(migrationBasePath)) {
        await migrateToFlatPhase(migrationBasePath);
        // The tree layout just changed (possibly by the lock holder we waited
        // on) — drop cached listings so detection sees the settled layout.
        clearParseCache();
        clearPathCache();
      }
    }

    // Self-heal phantom projection entries (#1257): a renamed/removed phase
    // directory leaves stale `.compat.json` projection paths that no detector
    // ever prunes (they all skip missing files), so the marker drifts from disk
    // reality permanently. Drop entries whose backing file is gone before the
    // detect passes run. Gated on !dryRun to keep detection read-only.
    const { pruneOrphanedProjectionEntries } = await import("../compat/compat-marker.js");
    const prunedCount = pruneOrphanedProjectionEntries(basePath);
    if (prunedCount > 0) {
      logWarning(
        "reconcile",
        `pruned ${prunedCount} orphaned projection entr${prunedCount === 1 ? "y" : "ies"} from .compat.json (backing file no longer on disk)`,
      );
    }
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    deps.invalidateStateCache();
    const stateSnapshot = await deps.deriveState(basePath, deps.deriveStateOptions);
    const ctx: DriftContext = { basePath, state: stateSnapshot, dryRun: deps.dryRun };

    const detection = await detectAllDrift(stateSnapshot, ctx, registry);
    const drift = detection.records;
    if (deps.dryRun && drift.length > 0) {
      const wouldRepair: DriftRecord[] = [];
      const blockers: string[] = [...detection.detectBlockers];
      const blockerDetails: ReconciliationBlockerDetail[] = [
        ...detection.detectBlockerDetails,
      ];
      for (const record of drift) {
        const handler = registry.find((h) => h.kind === record.kind);
        const blocker = handler?.blocker ? await handler.blocker(record, ctx) : null;
        if (blocker) {
          blockers.push(blocker);
          blockerDetails.push({ message: blocker, drift: record });
        } else {
          wouldRepair.push(record);
        }
      }
      return {
        ok: true,
        stateSnapshot,
        repaired: wouldRepair,
        blockers: [
          ...new Set([
            ...(stateSnapshot.blockers ?? []),
            ...blockers,
          ]),
        ],
        blockerDetails: dedupeBlockerDetails([
          ...stateBlockerDetails(stateSnapshot),
          ...blockerDetails,
        ]),
      };
    }
    if (drift.length === 0) {
      return {
        ok: true,
        stateSnapshot,
        repaired,
        blockers: [
          ...new Set([
            ...(stateSnapshot.blockers ?? []),
            ...detection.detectBlockers,
          ]),
        ],
        blockerDetails: dedupeBlockerDetails([
          ...stateBlockerDetails(stateSnapshot),
          ...detection.detectBlockerDetails,
        ]),
      };
    }

    const failures: ReconciliationFailureDetail[] = [];
    const blockers: string[] = [...detection.detectBlockers];
    const blockerDetails: ReconciliationBlockerDetail[] = [
      ...detection.detectBlockerDetails,
    ];
    let repairedThisPass = false;
    const repairedKindsThisPass = new Set<string>();

    for (const phase of repairPhases) {
      let phaseBlocked = false;
      for (const record of drift) {
        const recordKey = `${record.kind}:${JSON.stringify(record)}`;
        if (repairedKindsThisPass.has(recordKey)) continue;

        const handler = phase.handlers.find((h) => h.kind === record.kind);
        if (!handler) continue;

        const blocker = handler.blocker ? await handler.blocker(record, ctx) : null;
        if (blocker) {
          blockers.push(blocker);
          blockerDetails.push({ message: blocker, drift: record });
          phaseBlocked = true;
          continue;
        }
        try {
          await handler.repair(record, ctx);
          repaired.push(record);
          repairedKindsThisPass.add(recordKey);
          repairedThisPass = true;
        } catch (cause) {
          failures.push({ drift: record, cause });
        }
      }
      if (phase.stopOnBlocker && phaseBlocked) break;
    }

    if (repairedThisPass) {
      // A repair may have mutated on-disk structure (e.g. quarantined a slice
      // dir). Clear both the parse cache and the path/dir cache centrally so
      // later passes and any subsequent repair see fresh filesystem state.
      clearParseCache();
      clearPathCache();
    }
    if (blockers.length > 0) {
      let blockerState = stateSnapshot;
      if (repairedThisPass) {
        deps.invalidateStateCache();
        blockerState = await deps.deriveState(basePath, deps.deriveStateOptions);
      }
      return {
        ok: true,
        stateSnapshot: blockerState,
        repaired,
        blockers: [...new Set([...(blockerState.blockers ?? []), ...blockers])],
        blockerDetails: dedupeBlockerDetails([
          ...stateBlockerDetails(blockerState),
          ...blockerDetails,
        ]),
      };
    }
    if (failures.length > 0) {
      throw new ReconciliationFailedError({ failures, pass });
    }
    // Pass fully succeeded; loop runs again to detect cascading drift.
  }

  // After MAX_PASSES, one more derive+detect to verify nothing persists.
  deps.invalidateStateCache();
  const finalState = await deps.deriveState(basePath, deps.deriveStateOptions);
  const finalCtx: DriftContext = { basePath, state: finalState, dryRun: deps.dryRun };
  const finalDetection = await detectAllDrift(finalState, finalCtx, registry);
  const persistent = finalDetection.records;

  if (persistent.length > 0) {
    const blockers: string[] = [...finalDetection.detectBlockers];
    const blockerDetails: ReconciliationBlockerDetail[] = [
      ...finalDetection.detectBlockerDetails,
    ];
    const unblockedPersistent: DriftRecord[] = [];
    for (const record of persistent) {
      const handler = registry.find((h) => h.kind === record.kind);
      const blocker = handler?.blocker ? await handler.blocker(record, finalCtx) : null;
      if (blocker) {
        blockers.push(blocker);
        blockerDetails.push({ message: blocker, drift: record });
      } else {
        unblockedPersistent.push(record);
      }
    }
    if (blockers.length > 0 && unblockedPersistent.length === 0) {
      return {
        ok: true,
        stateSnapshot: finalState,
        repaired,
        blockers: [...new Set([...(finalState.blockers ?? []), ...blockers])],
        blockerDetails: dedupeBlockerDetails([
          ...stateBlockerDetails(finalState),
          ...blockerDetails,
        ]),
      };
    }
    throw new ReconciliationFailedError({ persistentDrift: persistent });
  }

  return {
    ok: true,
    stateSnapshot: finalState,
    repaired,
    blockers: [
      ...new Set([
        ...(finalState.blockers ?? []),
        ...finalDetection.detectBlockers,
      ]),
    ],
    blockerDetails: dedupeBlockerDetails([
      ...stateBlockerDetails(finalState),
      ...finalDetection.detectBlockerDetails,
    ]),
  };
}

function getRepairPhases(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: ReadonlyArray<DriftHandler<any>>,
): ReadonlyArray<ReconciliationRepairPhase> {
  const assigned = new Set<DriftHandler>();
  const phases = RECONCILIATION_REPAIR_PHASES.map((phase) => {
    const phaseKinds = new Set(phase.handlers.map((handler) => handler.kind));
    const handlers = registry.filter((handler) => phaseKinds.has(handler.kind));
    for (const handler of handlers) assigned.add(handler);
    return { name: phase.name, handlers, stopOnBlocker: phase.stopOnBlocker };
  }).filter((phase) => phase.handlers.length > 0);

  const unphasedHandlers = registry.filter((handler) => !assigned.has(handler));
  if (unphasedHandlers.length === 0) return phases;

  return [
    ...phases,
    {
      name: "custom",
      handlers: unphasedHandlers,
    },
  ];
}

interface DetectionOutcome {
  records: DriftRecord[];
  /** One blocker string per handler whose detect() threw. */
  detectBlockers: string[];
  detectBlockerDetails: ReconciliationBlockerDetail[];
}

/**
 * Run every detector. A single detector throwing (e.g. a transient file read
 * error) must NOT abort the whole cycle and hide every later handler's drift —
 * it is collected as a blocker so dispatch is still gated, while the remaining
 * detectors run and their drift gets repaired (graceful degradation, ADR-017).
 */
async function detectAllDrift(
  state: GSDState,
  ctx: DriftContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: ReadonlyArray<DriftHandler<any>>,
): Promise<DetectionOutcome> {
  const records: DriftRecord[] = [];
  const detectBlockers: string[] = [];
  const detectBlockerDetails: ReconciliationBlockerDetail[] = [];
  for (const handler of registry) {
    try {
      const detected = await handler.detect(state, ctx);
      records.push(...detected);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const blocker = `Drift detection failed for "${handler.kind}": ${message}`;
      logWarning("reconcile", blocker);
      detectBlockers.push(blocker);
      detectBlockerDetails.push({ message: blocker, detectorKind: handler.kind });
    }
  }
  return { records, detectBlockers, detectBlockerDetails };
}
