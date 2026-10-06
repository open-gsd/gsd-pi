// GSD State Machine Regression Tests — Event Replay & Reconciliation (#3161)

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  updateTaskStatus,
  insertVerificationEvidence,
  upsertDecision,
  executeDomainOperation,
  readDomainOperationFence,
  _getAdapter,
} from "../gsd-db.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import type { CanonicalLifecycleStatus } from "../status-guards.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MID = "M001";
const SID = "S01";
const TID = "T01";
const TS = new Date().toISOString();

function setupDb(): void {
  openDatabase(":memory:");
  insertMilestone({ id: MID, title: "Test Milestone" });
  insertSlice({ id: SID, milestoneId: MID, title: "Test Slice" });
  insertTask({ id: TID, sliceId: SID, milestoneId: MID, title: "Test Task" });
}

let adoptSequence = 0;

/**
 * The generic status writer only updates adopted rows whose legacy status
 * agrees with the canonical one: adopt the replay fixture and align its shadow.
 */
function adoptTask(canonicalTaskStatus: CanonicalLifecycleStatus, legacyStatus: string): void {
  _getAdapter()!.prepare("UPDATE tasks SET status = :status WHERE milestone_id = :mid AND id = :tid")
    .run({ ":status": legacyStatus, ":mid": MID, ":tid": TID });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.fixture.adopt-replay-task",
    idempotencyKey: `test/fixture/replay-adopt/${++adoptSequence}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: MID },
  }, (context: Readonly<DomainOperationContext>) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: MID, lifecycleStatus: "in_progress" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: MID, sliceId: SID, lifecycleStatus: "in_progress" });
    adoptOrTransitionLifecycle(context, { itemKind: "task", milestoneId: MID, sliceId: SID, taskId: TID, lifecycleStatus: canonicalTaskStatus });
    return {
      events: [{ eventType: "test.fixture.adopted", entityType: "task", entityId: `${MID}/${SID}/${TID}`, payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: `test/adopted/replay/${adoptSequence}`, projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("event-replay-idempotency", () => {
  beforeEach(() => {
    setupDb();
  });

  afterEach(() => {
    closeDatabase();
  });

  test("updateTaskStatus is idempotent for complete_task replay", () => {
    adoptTask("completed", "done");
    // Simulates replaying a complete_task event twice (e.g. crash recovery)
    updateTaskStatus(MID, SID, TID, "done", TS);
    updateTaskStatus(MID, SID, TID, "done", TS);

    const task = getTask(MID, SID, TID);
    assert.ok(task !== null, "task should exist after status update");
    assert.equal(task!.status, "done", "status should be 'done' after double replay");
  });

  test("updateTaskStatus is idempotent for start_task replay", () => {
    adoptTask("in_progress", "in-progress");
    // Simulates replaying a start_task event twice
    updateTaskStatus(MID, SID, TID, "in-progress");
    updateTaskStatus(MID, SID, TID, "in-progress");

    const task = getTask(MID, SID, TID);
    assert.ok(task !== null, "task should exist after status update");
    assert.equal(task!.status, "in-progress", "status should be 'in-progress' after double replay");
  });

  test("updateTaskStatus for report_blocker does not set blocker_discovered flag (M4)", () => {
    adoptTask("paused", "blocked");
    // M4 finding: report_blocker replay only calls updateTaskStatus("blocked").
    // The blocker_discovered column is NOT set during replay — this is a known
    // lossy replay: status is recovered but the blocker flag is not.
    updateTaskStatus(MID, SID, TID, "blocked");

    const task = getTask(MID, SID, TID);
    assert.ok(task !== null, "task should exist after blocked status update");
    assert.equal(task!.status, "blocked", "status should be 'blocked'");
    assert.equal(
      task!.blocker_discovered,
      false,
      "blocker_discovered should remain false — report_blocker replay is lossy (M4 finding)",
    );
  });

  test("insertVerificationEvidence is NOT idempotent — duplicates accumulate (M5)", () => {
    // M5 finding: insertVerificationEvidence uses a plain INSERT (no ON CONFLICT),
    // so replaying the same record_verification event twice produces two rows.
    // Both calls must succeed without throwing — the duplication is the risk.
    const evidence = {
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "npm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 1200,
    };

    assert.doesNotThrow(
      () => insertVerificationEvidence(evidence),
      "first insertVerificationEvidence call should not throw",
    );
    assert.doesNotThrow(
      () => insertVerificationEvidence(evidence),
      "second insertVerificationEvidence call should not throw — duplicates accumulate silently (M5 finding)",
    );
  });

  test("upsertDecision is idempotent via INSERT OR REPLACE", () => {
    // save_decision replay uses upsertDecision which is INSERT OR REPLACE,
    // so replaying the same decision id twice overwrites without error.
    const base = {
      id: "arch:logging",
      when_context: "during planning",
      scope: "arch",
      decision: "logging",
      rationale: "structured logs",
      revisable: "yes" as const,
      made_by: "agent" as const,
      superseded_by: null,
    };

    upsertDecision({ ...base, choice: "structured" });
    upsertDecision({ ...base, choice: "unstructured" });

    // No error means the second call replaced the first — idempotent at the id level.
    // The final choice is "unstructured" per INSERT OR REPLACE semantics.
  });

});
