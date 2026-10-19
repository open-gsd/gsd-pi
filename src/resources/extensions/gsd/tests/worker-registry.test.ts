/**
 * Tests for the parallel worker registry used by the dashboard overlay.
 *
 * Verifies worker lifecycle (register → update → cleanup), batch grouping,
 * and the hasActiveWorkers() status check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerWorker,
  updateWorker,
  getActiveWorkers,
  getWorkerBatches,
  hasActiveWorkers,
  resetWorkerRegistry,
  formatWorkerModelTokens,
  formatWorkerElapsed,
  formatWorkerIdentity,
} from '../../subagent/worker-registry.ts';


// ─── Setup ────────────────────────────────────────────────────────────────────

resetWorkerRegistry();

// ─── Registration ─────────────────────────────────────────────────────────────

console.log("\n=== Worker Registration ===");

{
  resetWorkerRegistry();
  const id = registerWorker("scout", "Explore codebase", 0, 3, "batch-1");
  assert.ok(id.startsWith("worker-"), "worker ID has correct prefix");
  const workers = getActiveWorkers();
  assert.deepStrictEqual(workers.length, 1, "one worker registered");
  assert.deepStrictEqual(workers[0].agent, "scout", "worker agent name correct");
  assert.deepStrictEqual(workers[0].task, "Explore codebase", "worker task correct");
  assert.deepStrictEqual(workers[0].status, "running", "worker starts as running");
  assert.deepStrictEqual(workers[0].index, 0, "worker index correct");
  assert.deepStrictEqual(workers[0].batchSize, 3, "worker batch size correct");
  assert.deepStrictEqual(workers[0].batchId, "batch-1", "worker batch ID correct");
}

// ─── Multiple workers in a batch ──────────────────────────────────────────────

console.log("\n=== Multiple Workers in a Batch ===");

{
  resetWorkerRegistry();
  const id1 = registerWorker("scout", "Task A", 0, 3, "batch-2");
  const id2 = registerWorker("researcher", "Task B", 1, 3, "batch-2");
  const id3 = registerWorker("worker", "Task C", 2, 3, "batch-2");

  const workers = getActiveWorkers();
  assert.deepStrictEqual(workers.length, 3, "three workers registered");
  assert.ok(hasActiveWorkers(), "has active workers");

  const batches = getWorkerBatches();
  assert.deepStrictEqual(batches.size, 1, "one batch");
  const batch = batches.get("batch-2");
  assert.ok(batch !== undefined, "batch-2 exists");
  assert.deepStrictEqual(batch!.length, 3, "batch has 3 workers");
}

// ─── Worker status updates ────────────────────────────────────────────────────

console.log("\n=== Worker Status Updates ===");

{
  resetWorkerRegistry();
  const id1 = registerWorker("scout", "Task A", 0, 2, "batch-3");
  const id2 = registerWorker("worker", "Task B", 1, 2, "batch-3");

  updateWorker(id1, "completed");
  const workers = getActiveWorkers();
  const w1 = workers.find(w => w.id === id1);
  assert.deepStrictEqual(w1?.status, "completed", "worker 1 marked completed");

  const w2 = workers.find(w => w.id === id2);
  assert.deepStrictEqual(w2?.status, "running", "worker 2 still running");
  assert.ok(hasActiveWorkers(), "still has active workers (worker 2 running)");
}

// ─── Failed worker ────────────────────────────────────────────────────────────

console.log("\n=== Failed Worker ===");

{
  resetWorkerRegistry();
  const id = registerWorker("scout", "Task A", 0, 1, "batch-4");
  updateWorker(id, "failed");
  const workers = getActiveWorkers();
  assert.deepStrictEqual(workers[0].status, "failed", "worker marked failed");
}

// ─── Multiple batches ─────────────────────────────────────────────────────────

console.log("\n=== Multiple Batches ===");

{
  resetWorkerRegistry();
  registerWorker("scout", "Task A", 0, 2, "batch-5");
  registerWorker("worker", "Task B", 1, 2, "batch-5");
  registerWorker("researcher", "Task C", 0, 1, "batch-6");

  const batches = getWorkerBatches();
  assert.deepStrictEqual(batches.size, 2, "two batches");
  assert.deepStrictEqual(batches.get("batch-5")!.length, 2, "batch-5 has 2 workers");
  assert.deepStrictEqual(batches.get("batch-6")!.length, 1, "batch-6 has 1 worker");
}

// ─── hasActiveWorkers with all completed ──────────────────────────────────────

console.log("\n=== hasActiveWorkers — all completed ===");

{
  resetWorkerRegistry();
  const id1 = registerWorker("scout", "Task A", 0, 2, "batch-7");
  const id2 = registerWorker("worker", "Task B", 1, 2, "batch-7");
  updateWorker(id1, "completed");
  updateWorker(id2, "completed");
  assert.ok(!hasActiveWorkers(), "no active workers when all completed");
}

// ─── Reset clears everything ─────────────────────────────────────────────────

console.log("\n=== Reset ===");

{
  registerWorker("scout", "Task", 0, 1, "batch-8");
  assert.ok(getActiveWorkers().length > 0, "workers exist before reset");
  resetWorkerRegistry();
  assert.deepStrictEqual(getActiveWorkers().length, 0, "no workers after reset");
  assert.ok(!hasActiveWorkers(), "hasActiveWorkers false after reset");
}

// ─── Update non-existent worker is no-op ──────────────────────────────────────

console.log("\n=== Update non-existent worker ===");

{
  resetWorkerRegistry();
  // Should not throw
  updateWorker("nonexistent-id", "completed");
  assert.deepStrictEqual(getActiveWorkers().length, 0, "no workers created by updating nonexistent");
}

// ─── Requested identity persistence (#2396) ───────────────────────────────────

console.log("\n=== Requested identity persistence (#2396) ===");

test("registerWorker persists requested model and thinking (#2396)", () => {
  resetWorkerRegistry();
  const id = registerWorker("scout", "Task A", 0, 2, "batch-id-1", {
    model: "gpt-5.6-sol",
    thinking: "high",
  });
  const w = getActiveWorkers().find(w => w.id === id);
  assert.deepStrictEqual(w?.model, "gpt-5.6-sol", "requested model persisted");
  assert.deepStrictEqual(w?.thinking, "high", "requested thinking persisted");
  assert.deepStrictEqual(w?.completedAt, undefined, "no completedAt while running");
});

test("registerWorker tolerates missing identity fields (#2396)", () => {
  resetWorkerRegistry();
  const id = registerWorker("scout", "Task A", 0, 1, "batch-id-2");
  const w = getActiveWorkers().find(w => w.id === id);
  assert.deepStrictEqual(w?.model, undefined, "model absent without identity");
  assert.deepStrictEqual(w?.thinking, undefined, "thinking absent without identity");
});

test("updateWorker stamps completedAt on terminal transitions (#2396)", () => {
  resetWorkerRegistry();
  const id = registerWorker("scout", "Task A", 0, 1, "batch-id-3");
  updateWorker(id, "completed");
  const w = getActiveWorkers().find(w => w.id === id);
  assert.ok(typeof w?.completedAt === "number", "completedAt set on terminal update");
  assert.ok(w!.completedAt! >= w!.startedAt, "completedAt does not precede startedAt");

  resetWorkerRegistry();
  const id2 = registerWorker("scout", "Task B", 0, 1, "batch-id-4");
  updateWorker(id2, "failed");
  const w2 = getActiveWorkers().find(w => w.id === id2);
  assert.ok(typeof w2?.completedAt === "number", "completedAt set on failed update");
});

// ─── Identity formatters (#2396) ──────────────────────────────────────────────

console.log("\n=== Identity formatters (#2396) ===");

test("formatWorkerModelTokens renders the requested ← reported convention (#2396)", () => {
  assert.deepStrictEqual(
    formatWorkerModelTokens({ model: "anthropic/claude-opus-4.7", reportedModel: "openrouter/auto", thinking: "high" }),
    "anthropic/claude-opus-4.7 ← openrouter/auto · high",
    "requested ← reported when provider model differs",
  );
  assert.deepStrictEqual(
    formatWorkerModelTokens({ model: "gpt-5.6-sol", reportedModel: "gpt-5.6-sol", thinking: "high" }),
    "gpt-5.6-sol · high",
    "no arrow when reported matches requested",
  );
  assert.deepStrictEqual(
    formatWorkerModelTokens({ reportedModel: "openrouter/auto" }),
    "openrouter/auto",
    "reported-only model still renders",
  );
  assert.deepStrictEqual(
    formatWorkerModelTokens({ model: "gpt-5.6-sol", thinking: undefined }),
    "gpt-5.6-sol",
    "missing thinking degrades",
  );
  assert.deepStrictEqual(formatWorkerModelTokens({}), "", "missing everything degrades to empty");
});

test("formatWorkerElapsed is deterministic and never negative (#2396)", () => {
  assert.deepStrictEqual(
    formatWorkerElapsed({ startedAt: 1000 }, "running", 64000),
    "running 1m 3s",
    "running elapsed uses the passed clock",
  );
  assert.deepStrictEqual(
    formatWorkerElapsed({ startedAt: 1000, completedAt: 61000 }, "completed", 999999999),
    "1m 0s",
    "completed elapsed uses completedAt, not the wall clock",
  );
  assert.deepStrictEqual(
    formatWorkerElapsed({ startedAt: 1000, completedAt: 88000 }, "failed", 999999999),
    "failed after 1m 27s",
    "failed wording uses completedAt",
  );
  assert.deepStrictEqual(
    formatWorkerElapsed({ startedAt: 5000, completedAt: 1000 }, "completed", 999999999),
    "0s",
    "clock anomaly clamps to zero (no negative durations)",
  );
  assert.deepStrictEqual(formatWorkerElapsed({}, "running"), "", "no elapsed without startedAt");
});

test("formatWorkerIdentity composes model · thinking · elapsed (#2396)", () => {
  assert.deepStrictEqual(
    formatWorkerIdentity({ model: "gpt-5.6-sol", thinking: "high", startedAt: 0 }, "running", 63000),
    "gpt-5.6-sol · high · running 1m 3s",
    "identity line: model · thinking · running X",
  );
  assert.deepStrictEqual(
    formatWorkerIdentity({ model: "gpt-5.6-luna", thinking: "medium", startedAt: 0, completedAt: 87000 }, "failed", 999999999),
    "gpt-5.6-luna · medium · failed after 1m 27s",
    "identity line retains attribution on failure",
  );
  assert.deepStrictEqual(
    formatWorkerIdentity({}, "completed", 999999999),
    "",
    "legacy result without fields renders empty identity",
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────
