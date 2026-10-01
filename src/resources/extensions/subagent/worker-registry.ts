/**
 * Worker Registry — Tracks active subagent sessions for dashboard visibility.
 *
 * Provides a global registry of currently-running parallel workers so the
 * GSD dashboard overlay can display real-time worker status.
 */

import { formatDuration } from "../shared/format-utils.js";

export interface WorkerEntry {
  id: string;
  agent: string;
  task: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  /** Index within a parallel batch (0-based) */
  index: number;
  /** Total workers in the parallel batch */
  batchSize: number;
  /** Unique batch identifier for grouping parallel runs */
  batchId: string;
  /** Requested model for this worker (#2396) */
  model?: string;
  /** Provider-reported model, when it differs from the requested one (#2396) */
  reportedModel?: string;
  /** Requested thinking level (#2396) */
  thinking?: string;
  /** When the worker reached a terminal state (#2396) */
  completedAt?: number;
}

/**
 * Structural identity fields shared by WorkerEntry and subagent results —
 * lets the formatters below serve both the dashboard rows and the tool card.
 */
export interface WorkerIdentityFields {
  model?: string;
  reportedModel?: string;
  thinking?: string;
  startedAt?: number;
  completedAt?: number;
}

export type WorkerIdentityState = "running" | "completed" | "failed";

/**
 * Format the model/thinking tokens for a worker: `model · thinking`, or
 * `model ← reported · thinking` when the provider reported a different
 * model (#2396). Missing fields degrade gracefully; empty string when
 * nothing is known.
 */
export function formatWorkerModelTokens(fields: WorkerIdentityFields): string {
  const parts: string[] = [];
  if (fields.model) {
    parts.push(
      fields.reportedModel && fields.reportedModel !== fields.model
        ? `${fields.model} ← ${fields.reportedModel}`
        : fields.model,
    );
  } else if (fields.reportedModel) {
    parts.push(fields.reportedModel);
  }
  if (fields.thinking) parts.push(fields.thinking);
  return parts.join(" · ");
}

/**
 * Format the elapsed token for a worker: `running 1m03s` while running,
 * `failed after X` on failure, plain duration on success. Returns "" when
 * no start timestamp is known. Clock anomalies clamp to 0 (no negatives).
 */
export function formatWorkerElapsed(
  fields: WorkerIdentityFields,
  state: WorkerIdentityState,
  now: number = Date.now(),
): string {
  if (fields.startedAt === undefined || !Number.isFinite(fields.startedAt)) return "";
  const end = state === "running" ? now : (fields.completedAt ?? now);
  const elapsed = Math.max(0, end - fields.startedAt);
  const duration = formatDuration(elapsed);
  if (state === "running") return `running ${duration}`;
  if (state === "failed") return `failed after ${duration}`;
  return duration;
}

/**
 * Full identity line for a worker: `model · thinking · running 1m03s`.
 */
export function formatWorkerIdentity(
  fields: WorkerIdentityFields,
  state: WorkerIdentityState,
  now: number = Date.now(),
): string {
  return [formatWorkerModelTokens(fields), formatWorkerElapsed(fields, state, now)]
    .filter(Boolean)
    .join(" · ");
}

const activeWorkers = new Map<string, WorkerEntry>();
let workerIdCounter = 0;

/**
 * Register a new worker. Returns the worker ID for later updates.
 * `identity` carries the requested model/thinking for display (#2396).
 */
export function registerWorker(
  agent: string,
  task: string,
  index: number,
  batchSize: number,
  batchId: string,
  identity?: { model?: string; thinking?: string },
): string {
  const id = `worker-${++workerIdCounter}`;
  activeWorkers.set(id, {
    id,
    agent,
    task,
    startedAt: Date.now(),
    status: "running",
    index,
    batchSize,
    batchId,
    ...(identity?.model !== undefined ? { model: identity.model } : {}),
    ...(identity?.thinking !== undefined ? { thinking: identity.thinking } : {}),
  });
  return id;
}

/**
 * Update worker status when it completes or fails.
 */
export function updateWorker(id: string, status: "completed" | "failed"): void {
  const entry = activeWorkers.get(id);
  if (entry) {
    entry.status = status;
    entry.completedAt = Date.now();
    // Remove after a brief display window (5 seconds)
    // unref() so the timer doesn't keep the process alive in test environments
    setTimeout(() => {
      activeWorkers.delete(id);
    }, 5000).unref();
  }
}

/**
 * Get all currently-tracked workers (running + recently completed).
 */
export function getActiveWorkers(): WorkerEntry[] {
  return Array.from(activeWorkers.values());
}

/**
 * Get workers grouped by batch.
 */
export function getWorkerBatches(): Map<string, WorkerEntry[]> {
  const batches = new Map<string, WorkerEntry[]>();
  for (const worker of activeWorkers.values()) {
    const batch = batches.get(worker.batchId) ?? [];
    batch.push(worker);
    batches.set(worker.batchId, batch);
  }
  return batches;
}

/**
 * Check if any parallel workers are currently running.
 */
export function hasActiveWorkers(): boolean {
  for (const worker of activeWorkers.values()) {
    if (worker.status === "running") return true;
  }
  return false;
}

/**
 * Reset registry state. Used for testing.
 */
export function resetWorkerRegistry(): void {
  activeWorkers.clear();
  workerIdCounter = 0;
}
