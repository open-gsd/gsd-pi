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
    // Host-task batches count terminal transitions cumulatively so the
    // dashboard header survives row expiry (#2533). GSD `subagent` batches
    // keep their retained-row accounting.
    const stats = hostTaskBatchStats.get(entry.batchId);
    if (stats) {
      if (status === "completed") stats.done += 1;
      else stats.failed += 1;
    }
    // Remove after a brief display window (5 seconds)
    // unref() so the timer doesn't keep the process alive in test environments
    setTimeout(() => {
      activeWorkers.delete(id);
    }, 5000).unref();
  }
}

/**
 * Register a host-native background task (e.g. a Claude Code `Agent`/`Bash`
 * fan-out reported through the SDK's `task_started` messages) for dashboard
 * visibility (#2533). Unlike `registerWorker`, the batch size is not known up
 * front: a per-batch total (independent of row expiry) grows as tasks register
 * and every row in the batch tracks it, so the dashboard's `done/total` header
 * stays honest even when early rows have already aged out. The owning stream
 * attempt calls {@link releaseHostTaskBatch} when it ends. Returns the
 * registry worker id for later `updateWorker` calls.
 */
const hostTaskBatchTotals = new Map<string, number>();
/** Expiry-independent done/failed counts per host-task batch (#2533). */
const hostTaskBatchStats = new Map<string, { total: number; done: number; failed: number }>();

export function registerHostTaskWorker(input: {
  batchId: string;
  agent: string;
  task: string;
}): string {
  const total = (hostTaskBatchTotals.get(input.batchId) ?? 0) + 1;
  hostTaskBatchTotals.set(input.batchId, total);
  const stats = hostTaskBatchStats.get(input.batchId) ?? { total: 0, done: 0, failed: 0 };
  stats.total = total;
  hostTaskBatchStats.set(input.batchId, stats);
  const batchRows = Array.from(activeWorkers.values()).filter(
    (entry) => entry.batchId === input.batchId,
  );
  const id = `worker-${++workerIdCounter}`;
  activeWorkers.set(id, {
    id,
    agent: input.agent,
    task: input.task,
    startedAt: Date.now(),
    status: "running",
    index: total - 1,
    batchSize: total,
    batchId: input.batchId,
  });
  for (const entry of batchRows) {
    entry.batchSize = total;
  }
  return id;
}

/**
 * Cumulative progress for a host-task batch, independent of row expiry.
 * `undefined` when the batch id was never registered as a host-task batch
 * (GSD `subagent` batches keep their retained-row accounting).
 */
export function getHostTaskBatchStats(
  batchId: string,
): { total: number; done: number; failed: number } | undefined {
  return hostTaskBatchStats.get(batchId);
}

/**
 * Drop a host-task batch's running total once its owning stream attempt has
 * ended, so batch accounting never outlives the stream that created it.
 */
export function releaseHostTaskBatch(batchId: string): void {
  hostTaskBatchTotals.delete(batchId);
  hostTaskBatchStats.delete(batchId);
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
  hostTaskBatchTotals.clear();
  hostTaskBatchStats.clear();
  workerIdCounter = 0;
}
