// Project/App: gsd-pi
// File Purpose: ADR-017 stale-worker drift handler. Detects session-lock
// artifacts whose owning PID is no longer alive (typical after SIGKILL or
// laptop sleep where the heartbeat wasn't released cleanly), and clears them
// before the next dispatch attempts to acquire the lock.

import {
  effectiveLockFile,
  isSessionLockProcessAlive,
  readSessionLockData,
  removeStaleSessionLock,
} from "../../session-lock.js";
import { clearStaleWorkerLock } from "../../crash-recovery.js";
import { findStaleWorkerForProject } from "../../db/auto-workers.js";
import { isDbAvailable } from "../../gsd-db.js";
import { normalizeRealPath } from "../../paths.js";
import { logWarning } from "../../workflow-logger.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type StaleWorkerDrift = Extract<DriftRecord, { kind: "stale-worker" }>;

export function detectStaleWorkerDrift(
  _state: GSDState,
  ctx: DriftContext,
): StaleWorkerDrift[] {
  const data = readSessionLockData(ctx.basePath);
  if (data && typeof data.pid === "number") {
    return isSessionLockProcessAlive(data)
      ? []
      : [{ kind: "stale-worker", lockPath: effectiveLockFile(), pid: data.pid }];
  }

  // The lock file is missing or unparseable. It is not the only source of
  // truth: a crashed worker can leave a workers row 'active' with held leases
  // and in-flight dispatches even when its lock file is gone. Fall back to the
  // DB worker registry so that state is still detected and repaired.
  if (isDbAvailable()) {
    try {
      const stale = findStaleWorkerForProject(normalizeRealPath(ctx.basePath));
      if (stale && typeof stale.pid === "number") {
        return [{ kind: "stale-worker", lockPath: effectiveLockFile(), pid: stale.pid }];
      }
    } catch (err) {
      // Best-effort: detection must never throw and abort the reconcile cycle.
      logWarning(
        "reconcile",
        `stale-worker DB fallback detection failed: ${(err as Error).message}`,
      );
    }
  }

  return [];
}

export function repairStaleWorker(_record: StaleWorkerDrift, ctx: DriftContext): void {
  // removeStaleSessionLock is idempotent: it re-reads lock state and is a
  // no-op when the lock is held by an alive process. Safe under cap=2 retry.
  removeStaleSessionLock(ctx.basePath);

  // Removing the lock file alone leaves the DB-side worker state dangling: the
  // dead worker's milestone_leases stay 'held' and its unit_dispatches stay
  // 'running'/'claimed', blocking new claims until the lease TTL expires.
  // clearStaleWorkerLock cancels those dispatches, releases the leases, and
  // marks the worker stopping — the same cleanup the startup crash-recovery
  // path performs. It is DB-gated, idempotent, and best-effort.
  clearStaleWorkerLock(ctx.basePath);
}

export const staleWorkerHandler: DriftHandler<StaleWorkerDrift> = {
  kind: "stale-worker",
  detect: detectStaleWorkerDrift,
  repair: repairStaleWorker,
};
