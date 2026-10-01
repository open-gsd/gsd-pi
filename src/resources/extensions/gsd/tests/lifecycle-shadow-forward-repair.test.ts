// Project/App: gsd-pi
// File Purpose: Executable contract for evidence-gated forward lifecycle-shadow repair.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  repairLifecycleShadowStep,
  type CanonicalLifecycleStatus,
  type LifecycleIdentity,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  _setLifecycleShadowRepairBeforeCommitForTest,
  repairLifecycleShadowForward,
  repairMilestoneLifecycleShadowsForward,
} from "../lifecycle-shadow-repair-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { handleCompleteSlice } from "../tools/complete-slice.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  _setLifecycleShadowRepairBeforeCommitForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function openFixture(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-forward-repair-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Historical milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Historical slice', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      (
        'M001', 'S01', 'T01', 'Missing terminal shadow', 'complete',
        '2026-07-02T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary'
      ),
      (
        'M001', 'S01', 'T02', 'Ready bootstrap head', 'complete',
        '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T02 summary'
      ),
      (
        'M001', 'S01', 'T03', 'Unsupported evidence', 'complete',
        NULL, '', '', '', ''
      );
  `);
  t.after(closeDatabase);
}

/**
 * #2313 end-to-end fixture: the legacy-import shadow shape where the Slice and
 * Task have canonical authority (the Task with a full completion proof chain)
 * but the parent Milestone's canonical row is missing. `gsd_slice_complete`
 * must restore the Milestone authority and then complete the Slice.
 */
function openSliceCompletionFixture(t: TestContext): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-shadow-slice-complete-"));
  tempDirs.add(basePath);
  const phaseDir = join(basePath, ".gsd", "phases", "01-historical");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(
    join(phaseDir, "01-ROADMAP.md"),
    "# M001: Historical milestone\n\n## Slices\n\n- [ ] **S01: Historical slice** `risk:medium` `depends:[]`\n  - After this: the historical slice is closed\n",
  );
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Historical milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Historical slice', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M001', 'S01', 'T01', 'Historical task', 'complete',
      '2026-07-02T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary'
    );
  `);
  seedSliceCompletionAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    completedTaskIds: ["T01"],
    adoptMilestone: false,
  });
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles WHERE item_kind = 'milestone'
  `).get()?.["count"], 0, "fixture must start without canonical Milestone authority");
  t.after(closeDatabase);
  return basePath;
}

function insertNonPassingVerificationTask(t: TestContext, verificationResult: string): void {
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M002', 'Isolated milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M002', 'S01', 'Isolated slice', 'active', '2026-07-01T00:00:00.000Z');
  `);
  db().prepare(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M002', 'S01', 'T04', 'Non-passing verification result', 'complete',
      '2026-07-04T00:00:00.000Z', 'Finished', 'Historical completion', ?, '# T04 summary'
    )
  `).run(verificationResult);
  t.after(closeDatabase);
}

function isolatedTask(taskId: string) {
  return {
    itemKind: "task" as const,
    milestoneId: "M002",
    sliceId: "S01",
    taskId,
  };
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "shadow-repair-test",
    traceId: "trace-shadow-repair",
    turnId: "turn-shadow-repair",
  };
}

function task(taskId: string) {
  return {
    itemKind: "task" as const,
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
  };
}

function seedLifecycle(
  item: LifecycleIdentity,
  status: CanonicalLifecycleStatus,
  idempotencyKey: string,
): void {
  const id = [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
  const payload: DomainJsonValue = {
    itemKind: item.itemKind,
    milestoneId: item.milestoneId,
    sliceId: item.sliceId ?? null,
    taskId: item.taskId ?? null,
    status,
  };
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.lifecycle.seed",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      ...item,
      lifecycleStatus: status,
    });
    return {
      events: [{
        eventType: "test.lifecycle.seeded",
        entityType: item.itemKind,
        entityId: id,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: idempotencyKey.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function adoptReadyItem(item: LifecycleIdentity): void {
  const id = [item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/");
  seedLifecycle(item, "ready", `test/bootstrap/${item.itemKind}/${id}`);
}

function transitionTask(taskId: string, status: "paused" | "in_progress", key: string): void {
  seedLifecycle(task(taskId), status, key);
}

function rows(table: string): Array<Record<string, unknown>> {
  return db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function authoritySnapshot(): Record<string, unknown> {
  return {
    authority: db().prepare("SELECT revision, authority_epoch FROM project_authority").get(),
    hierarchy: db().prepare(`
      SELECT id, status, completed_at, one_liner, narrative, verification_result
      FROM tasks ORDER BY id
    `).all(),
    lifecycles: rows("workflow_item_lifecycles"),
    attempts: rows("workflow_execution_attempts"),
    results: rows("workflow_attempt_results"),
    operations: rows("workflow_operations"),
    events: rows("workflow_domain_events"),
    projections: rows("workflow_projection_work"),
  };
}

test("adopts a missing historical terminal Task shadow only from durable completion evidence", (t) => {
  openFixture(t);
  const beforeLegacy = db().prepare("SELECT * FROM tasks WHERE id = 'T01'").get();

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/missing/T01"),
    item: task("T01"),
  });

  assert.equal(receipt.status, "committed");
  assert.equal(receipt.disposition, "repaired");
  assert.equal(receipt.beforeStatus, null);
  assert.equal(receipt.targetStatus, "completed");
  assert.equal(receipt.afterStatus, "completed");
  assert.equal(receipt.evidence?.kind, "legacy_completion");
  assert.equal(receipt.evidence?.legacyStatus, "complete");
  assert.equal(receipt.evidence?.completedAt, "2026-07-02T00:00:00.000Z");
  assert.equal(receipt.evidence?.verificationResult, "passed");
  assert.match(receipt.evidence?.evidenceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(db().prepare("SELECT * FROM tasks WHERE id = 'T01'").get(), beforeLegacy);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);

  const event = db().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'lifecycle.shadow.repaired'
  `).get({ ":operation_id": receipt.operationId });
  const payload = JSON.parse(String(event?.["payload_json"]));
  assert.equal(payload.afterStatus, "completed");
  assert.equal(payload.beforeStatus, null);
  assert.equal(payload.disposition, "repaired");
  assert.deepEqual(payload.evidence, receipt.evidence);
  assert.deepEqual(payload.item, task("T01"));
  assert.equal(payload.targetStatus, "completed");
  assert.equal(payload.comparison.kind, "missing_shadow");
  assert.equal(payload.reason, null);
});

test("advances and then completes a ready historical Task through two separate calls", (t) => {
  openFixture(t);
  adoptReadyItem(task("T02"));

  const advanced = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/ready/T02/advance"),
    item: task("T02"),
  });
  assert.equal(advanced.disposition, "advanced");
  assert.equal(advanced.beforeStatus, "ready");
  assert.equal(advanced.afterStatus, "in_progress");

  const completed = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/ready/T02/complete"),
    item: task("T02"),
  });
  assert.equal(completed.disposition, "repaired");
  assert.equal(completed.beforeStatus, "in_progress");
  assert.equal(completed.afterStatus, "completed");
  assert.notEqual(advanced.operationId, completed.operationId);

  const operations = db().prepare(`
    SELECT operation_id, operation_type, resulting_revision
    FROM workflow_operations
    WHERE operation_id IN (:first, :second)
    ORDER BY resulting_revision
  `).all({
    ":first": advanced.operationId,
    ":second": completed.operationId,
  });
  assert.deepEqual(operations.map((row) => row["operation_type"]), [
    "lifecycle.shadow.repair",
    "lifecycle.shadow.repair",
  ]);
  assert.equal(Number(operations[1]?.["resulting_revision"]), Number(operations[0]?.["resulting_revision"]) + 1);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);
});

test("does not complete an in-progress Task whose current head is not its advance receipt", (t) => {
  openFixture(t);
  adoptReadyItem(task("T02"));
  const advanced = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/non-current/T02/advance"),
    item: task("T02"),
  });
  assert.equal(advanced.disposition, "advanced");
  transitionTask("T02", "paused", "test/non-current/T02/paused");
  transitionTask("T02", "in_progress", "test/non-current/T02/in-progress");

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/non-current/T02/complete"),
    item: task("T02"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, "in_progress");
  assert.equal(receipt.afterStatus, "in_progress");
});

test("exact replay returns the stored repair receipt and changed key reuse conflicts", (t) => {
  openFixture(t);
  const input = {
    invocation: invocation("shadow-repair/replay"),
    item: task("T01"),
  };
  const committed = repairLifecycleShadowForward(input);
  const afterCommit = authoritySnapshot();
  const replayed = repairLifecycleShadowForward(input);

  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(authoritySnapshot(), afterCommit);
  assert.throws(() => repairLifecycleShadowForward({
    ...input,
    item: task("T02"),
  }), /idempotency conflict/i);
  assert.deepEqual(authoritySnapshot(), afterCommit);
});

test("unsupported historical evidence commits an actionable unresolved receipt without lifecycle mutation", (t) => {
  openFixture(t);
  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/unresolved/T03"),
    item: task("T03"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, null);
  assert.equal(receipt.targetStatus, null);
  assert.equal(receipt.afterStatus, null);
  assert.match(receipt.reason ?? "", /durable completion evidence/i);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles WHERE task_id = 'T03'
  `).get()?.["count"], 0);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);
});

test("a non-passing verification_result must not be treated as durable completion evidence", (t) => {
  openFixture(t);
  insertNonPassingVerificationTask(t, "failed");
  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/non-passing/T04"),
    item: isolatedTask("T04"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.targetStatus, null);
  assert.equal(receipt.afterStatus, null);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles WHERE task_id = 'T04'
  `).get()?.["count"], 0);
});

for (const variant of ["PASSED", "  passed  ", "Passed"]) {
  test(`a "${variant}" verification_result is still normalized as passing evidence`, (t) => {
    openFixture(t);
    insertNonPassingVerificationTask(t, variant);

    const receipt = repairLifecycleShadowForward({
      invocation: invocation(`shadow-repair/normalized-passing/T04/${variant}`),
      item: isolatedTask("T04"),
    });

    assert.equal(receipt.disposition, "repaired");
    assert.equal(receipt.afterStatus, "completed");
  });
}

test("a recorded failed verification is rejected regardless of case or padding", (t) => {
  openFixture(t);
  insertNonPassingVerificationTask(t, "  FAILED  ");

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/non-passing/T04/padded-failed"),
    item: isolatedTask("T04"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.afterStatus, null);
});

// #2313: legacy completion (gsd_task_complete) persists the free-text
// verification narrative verbatim, so only an explicit failure marker counts
// as a recorded failed verification. Any other narrative is adoptable
// evidence — matching the milestone-closeout adoption sweep, which never
// gated on verification_result.
for (const variant of ["inconclusive", "needs-attention", "true", "banana", "NULL"]) {
  test(`a "${variant}" verification_result is adoptable free-text evidence (#2313)`, (t) => {
    openFixture(t);
    insertNonPassingVerificationTask(t, variant);

    const receipt = repairLifecycleShadowForward({
      invocation: invocation(`shadow-repair/free-text/T04/${variant}`),
      item: isolatedTask("T04"),
    });

    assert.equal(receipt.disposition, "repaired");
    assert.equal(receipt.afterStatus, "completed");
  });
}

test("a legacy verification narrative is adoptable evidence, not a failed verification (#2313)", (t) => {
  openFixture(t);
  insertNonPassingVerificationTask(
    t,
    "Ran the required targeted Jest command; all 6 suites and 38 tests passed after the fix.",
  );

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/free-text/T04/narrative"),
    item: isolatedTask("T04"),
  });

  assert.equal(receipt.disposition, "repaired");
  assert.equal(receipt.afterStatus, "completed");
});

test("records an extra canonical shadow as unresolved when its legacy row is missing", (t) => {
  openFixture(t);
  adoptReadyItem(task("T03"));
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare("DELETE FROM tasks WHERE id = 'T03'").run();
  db().exec("PRAGMA foreign_keys = ON");

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/extra/T03"),
    item: task("T03"),
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, "ready");
  assert.equal(receipt.afterStatus, "ready");
  assert.equal(receipt.targetStatus, null);
  assert.equal(receipt.comparison.kind, "extra_shadow");
  assert.match(receipt.reason ?? "", /legacy hierarchy row is missing/i);
});

test("the repair writer rejects a caller whose expected before status is stale", (t) => {
  openFixture(t);
  adoptReadyItem(task("T02"));
  const before = authoritySnapshot();
  const fence = readDomainOperationFence();

  assert.throws(() => executeDomainOperation({
    operationType: "lifecycle.shadow.repair",
    idempotencyKey: "shadow-repair/wrong-before/T02",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: { item: task("T02") },
  }, (context) => {
    repairLifecycleShadowStep(context, {
      ...task("T02"),
      expectedBeforeStatus: null,
      targetStatus: "completed",
    });
    throw new Error("unreachable");
  }), /current status does not match expected before status/i);
  assert.deepEqual(authoritySnapshot(), before);
});

const unsupportedWriterEdges: Array<{
  name: string;
  item: LifecycleIdentity;
  before: CanonicalLifecycleStatus;
  target: "in_progress" | "completed";
}> = [
  { name: "ready Milestone completion", item: { itemKind: "milestone", milestoneId: "M001" }, before: "ready", target: "completed" },
  { name: "ready Milestone advance", item: { itemKind: "milestone", milestoneId: "M001" }, before: "ready", target: "in_progress" },
  { name: "ready Slice advance", item: { itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, before: "ready", target: "in_progress" },
  { name: "in-progress Slice completion", item: { itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, before: "in_progress", target: "completed" },
  { name: "paused Task advance", item: task("T01"), before: "paused", target: "in_progress" },
  { name: "completed Task same-status repair", item: task("T01"), before: "completed", target: "completed" },
  { name: "cancelled Task completion", item: task("T01"), before: "cancelled", target: "completed" },
  { name: "ready Task direct completion", item: task("T01"), before: "ready", target: "completed" },
];

for (const repairCase of unsupportedWriterEdges) {
  test(`repair writer rejects ${repairCase.name}`, (t) => {
    openFixture(t);
    seedLifecycle(repairCase.item, repairCase.before, `test/invalid-edge/seed/${repairCase.name}`);
    const before = authoritySnapshot();
    const fence = readDomainOperationFence();

    assert.throws(() => executeDomainOperation({
      operationType: "lifecycle.shadow.repair",
      idempotencyKey: `test/invalid-edge/repair/${repairCase.name}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "agent",
      sourceTransport: "test",
      payload: { name: repairCase.name },
    }, (context) => {
      repairLifecycleShadowStep(context, {
        ...repairCase.item,
        expectedBeforeStatus: repairCase.before,
        targetStatus: repairCase.target,
      });
      throw new Error("unreachable");
    }), /unsupported lifecycle shadow repair edge/i);
    assert.deepEqual(authoritySnapshot(), before);
  });
}

test("repair writer rejects a missing Task open adoption (#2313 edge is Milestone/Slice only)", (t) => {
  openFixture(t);
  const before = authoritySnapshot();
  const fence = readDomainOperationFence();

  assert.throws(() => executeDomainOperation({
    operationType: "lifecycle.shadow.repair",
    idempotencyKey: "test/invalid-edge/repair/missing Task open adoption",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    repairLifecycleShadowStep(context, {
      ...task("T01"),
      expectedBeforeStatus: null,
      targetStatus: "ready",
    });
    throw new Error("unreachable");
  }), /unsupported lifecycle shadow repair edge/i);
  assert.deepEqual(authoritySnapshot(), before);
});

test("repairs Slice and Milestone shadows only when every descendant has completion evidence", (t) => {
  openFixture(t);
  db().exec(`
    DELETE FROM tasks WHERE id = 'T03';
    UPDATE slices
    SET status = 'complete', completed_at = '2026-07-04T00:00:00.000Z',
        full_summary_md = '# S01 summary'
    WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE milestones
    SET status = 'complete', completed_at = '2026-07-05T00:00:00.000Z'
    WHERE id = 'M001';
  `);

  const slice = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/slice/S01"),
    item: { itemKind: "slice", milestoneId: "M001", sliceId: "S01" },
  });
  const milestone = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/milestone/M001"),
    item: { itemKind: "milestone", milestoneId: "M001" },
  });

  assert.equal(slice.afterStatus, "completed");
  assert.equal(milestone.afterStatus, "completed");
  assert.match(slice.evidence?.evidenceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.match(milestone.evidence?.evidenceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(rows("workflow_execution_attempts").length, 0);
  assert.equal(rows("workflow_attempt_results").length, 0);
});

test("keeps a ready Milestone unresolved even when historical completion evidence is complete", (t) => {
  openFixture(t);
  db().exec(`
    DELETE FROM tasks WHERE id = 'T03';
    UPDATE slices
    SET status = 'complete', completed_at = '2026-07-04T00:00:00.000Z',
        full_summary_md = '# S01 summary';
    UPDATE milestones
    SET status = 'complete', completed_at = '2026-07-05T00:00:00.000Z';
  `);
  adoptReadyItem({ itemKind: "milestone", milestoneId: "M001" });

  const receipt = repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/ready-milestone/M001"),
    item: { itemKind: "milestone", milestoneId: "M001" },
  });

  assert.equal(receipt.disposition, "unresolved");
  assert.equal(receipt.beforeStatus, "ready");
  assert.equal(receipt.afterStatus, "ready");
  assert.equal(receipt.targetStatus, "completed");
});

test("FIXED: a milestone with one repairable and one unresolved descendant repairs only the milestone authority and reports both descendants as unresolved", (t) => {
  openFixture(t);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M003', 'Mixed repairable milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES
      ('M003', 'S01', 'Repairable slice', 'active', '2026-07-01T00:00:00.000Z'),
      ('M003', 'S02', 'Unresolved slice', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      (
        'M003', 'S01', 'T01', 'Repairable task', 'complete',
        '2026-07-02T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary'
      ),
      (
        'M003', 'S02', 'T02', 'Unresolved task', 'complete',
        '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'failed', '# T02 summary'
      );
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/mixed-order/M003"),
    milestoneId: "M003",
  });

  // #2313: missing canonical open-item authority (the Milestone and the two
  // legacy-open Slices) is restored, but no descendant completion may be
  // repaired while any sibling in the milestone is unresolved.
  assert.deepEqual(result.repaired, ["M003", "M003/S01", "M003/S02"]);
  assert.deepEqual([...result.unresolved].sort(), ["M003/S02/T02", "M003/S01/T01"].sort());
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M003' AND item_kind = 'task'
  `).get()?.["count"], 0, "no descendant Task may be repaired while any sibling in the milestone is unresolved");
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M003' AND lifecycle_status = 'ready'
  `).get()?.["count"], 3, "only open-item authority rows (Milestone + Slices) may be written");
});

test("FIXED: a milestone with multiple repairable single-step descendants commits them all in one shared Domain Operation", (t) => {
  openFixture(t);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M004', 'Fully repairable milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES
      ('M004', 'S01', 'Repairable slice one', 'active', '2026-07-01T00:00:00.000Z'),
      ('M004', 'S02', 'Repairable slice two', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES
      (
        'M004', 'S01', 'T01', 'Repairable task one', 'complete',
        '2026-07-02T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary'
      ),
      (
        'M004', 'S02', 'T02', 'Repairable task two', 'complete',
        '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T02 summary'
      );
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/all-repairable/M004"),
    milestoneId: "M004",
  });

  assert.deepEqual([...result.repaired].sort(), ["M004", "M004/S01", "M004/S02", "M004/S01/T01", "M004/S02/T02"].sort());
  assert.deepEqual(result.unresolved, []);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M004' AND lifecycle_status = 'completed'
  `).get()?.["count"], 2);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'lifecycle.shadow.repair'
  `).get()?.["count"], 4, "three open-item authority adoptions (Milestone + 2 Slices) plus one shared descendant batch");
});

test("a changed evidence digest is rejected inside the repair transaction", (t) => {
  openFixture(t);
  _setLifecycleShadowRepairBeforeCommitForTest(() => {
    db().prepare("UPDATE tasks SET full_summary_md = '# changed' WHERE id = 'T01'").run();
  });

  assert.throws(() => repairLifecycleShadowForward({
    invocation: invocation("shadow-repair/stale-evidence"),
    item: task("T01"),
  }), /stable durable completion evidence/i);
  assert.equal(rows("workflow_operations").length, 0);
  assert.equal(rows("workflow_item_lifecycles").length, 0);
});

const precommitFaults: DomainOperationFaultPoint[] = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
];

type RepairEdge = "adopt" | "advance" | "complete";

function prepareRepairEdge(edge: RepairEdge, key: string) {
  if (edge === "adopt") {
    return {
      invocation: invocation(key),
      item: task("T01"),
    };
  }
  adoptReadyItem(task("T02"));
  if (edge === "complete") {
    const advanced = repairLifecycleShadowForward({
      invocation: invocation(`${key}/prior-advance`),
      item: task("T02"),
    });
    assert.equal(advanced.disposition, "advanced");
  }
  return {
    invocation: invocation(key),
    item: task("T02"),
  };
}

for (const edge of ["adopt", "advance", "complete"] as const) {
  for (const fault of precommitFaults) {
    test(`${edge} ${fault} fault leaves the exact prior snapshot`, (t) => {
      openFixture(t);
      const input = prepareRepairEdge(edge, `shadow-repair/fault/${edge}/${fault}`);
      const before = authoritySnapshot();
      _setDomainOperationFaultForTest(fault);

      assert.throws(
        () => repairLifecycleShadowForward(input),
        new RegExp(`domain operation fault: ${fault}`, "i"),
      );
      assert.deepEqual(authoritySnapshot(), before);
    });
  }

  test(`${edge} after-commit lost response replays exactly one stored edge`, (t) => {
    openFixture(t);
    const input = prepareRepairEdge(edge, `shadow-repair/fault/${edge}/after-commit`);
    const operationCountBefore = rows("workflow_operations").length;
    _setDomainOperationFaultForTest("after-commit");
    assert.throws(() => repairLifecycleShadowForward(input), /domain operation fault: after-commit/i);
    _setDomainOperationFaultForTest(null);
    const afterCommit = authoritySnapshot();
    assert.equal(rows("workflow_operations").length, operationCountBefore + 1);

    const replayed = repairLifecycleShadowForward(input);
    assert.equal(replayed.status, "replayed");
    assert.deepEqual(authoritySnapshot(), afterCommit);
  });
}

test("repairMilestoneLifecycleShadowsForward skips completed or cancelled milestones", (t) => {
  openFixture(t);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES
      ('M010', 'Completed milestone', 'completed', '2026-07-01T00:00:00.000Z'),
      ('M010C', 'Cancelled milestone', 'cancelled', '2026-07-01T00:00:00.000Z');
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M010" }, "completed", "test/seed/m010");
  seedLifecycle({ itemKind: "milestone", milestoneId: "M010C" }, "cancelled", "test/seed/m010c");

  const resultCompleted = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/completed-milestone/M010"),
    milestoneId: "M010",
  });
  const resultCancelled = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/cancelled-milestone/M010C"),
    milestoneId: "M010C",
  });

  assert.deepEqual(resultCompleted, { repaired: [], unresolved: [] });
  assert.deepEqual(resultCancelled, { repaired: [], unresolved: [] });
});

test("repairMilestoneLifecycleShadowsForward runs task repairs before slice repairs", (t) => {
  openFixture(t);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M011', 'Ordering milestone', 'active', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at, completed_at, full_summary_md)
    VALUES ('M011', 'S01', 'Slice 1', 'complete', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '# S01 summary');
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M011', 'S01', 'T01', 'Task 1', 'complete',
      '2026-07-02T00:00:00.000Z', 'Finished', 'Historical', 'passed', '# T01 summary'
    );
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/task-before-slice/M011"),
    milestoneId: "M011",
  });

  assert.deepEqual(result.repaired, ["M011", "M011/S01/T01", "M011/S01"]);
});

// ── Sibling corroboration (#2002 x #2070): a canonically-completed sibling
// establishes the adoption pattern, deferring bare legacy-complete
// stragglers to milestone completion; without it the strict gate applies. ──

function insertCanonicalCompletedSibling(milestoneId: string, sliceId: string, taskId: string): void {
  // The corroboration sibling is a canonical shadow row; FK targets
  // (project_authority / workflow_operations) are not the subject here.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'corroboration-' || :task_id, 'test-project', 'task', :milestone_id, :slice_id, :task_id,
      'completed', 1, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
      'fixture-adopt', 1, 0
    )
  `).run({ ":milestone_id": milestoneId, ":slice_id": sliceId, ":task_id": taskId });
  db().exec("PRAGMA foreign_keys = ON");
}

test("an evidenced descendant is repaired while bare stragglers defer when a sibling is canonically complete", (t) => {
  openFixture(t);
  insertCanonicalCompletedSibling("M001", "S01", "T01");
  // T04 here: legacy complete, no durable evidence, canonical row absent —
  // the exact bare straggler shape from #2070.
  db().exec(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M001', 'S01', 'T04', 'Bare straggler', 'complete',
      '2026-07-04T00:00:00.000Z', 'Finished', 'Historical completion', '', ''
    );
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/corroboration/deferred"),
    milestoneId: "M001",
  });

  // The evidenced T02 is repaired by the evidence gate (#2313 — slice
  // completion has no sweep, so evidence-backed descendants must not defer).
  // The bare T04 straggler is neither repaired nor unresolved — completion
  // adopts it. Missing canonical open-item authority (Milestone + the
  // legacy-open Slice) is restored first.
  assert.deepEqual(result.repaired, ["M001", "M001/S01", "M001/S01/T02"]);
  assert.deepEqual(result.unresolved, []);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind = 'task'
  `).get()?.["count"], 2, "only the evidenced T02 joins the sibling; the bare straggler is not adopted");
});

test("a bare straggler with recorded failed verification blocks even with sibling corroboration", (t) => {
  openFixture(t);
  insertCanonicalCompletedSibling("M001", "S01", "T01");
  db().exec(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M001', 'S01', 'T05', 'Failed-verification straggler', 'complete',
      '2026-07-04T00:00:00.000Z', 'Finished', 'Historical completion', 'failed', '# T05 summary'
    );
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/corroboration/failed"),
    milestoneId: "M001",
  });

  // #2313: missing canonical open-item authority is restored even when a
  // descendant stays unresolved — the failed verification must surface as its
  // own precise item instead of hiding behind the parent-authority gate.
  // #2002's atomicity is unchanged: the evidenced T02 joins T05 in the
  // unresolved report and no descendant Task is written.
  assert.deepEqual(result.repaired, ["M001", "M001/S01"]);
  assert.deepEqual([...result.unresolved].sort(), ["M001/S01/T02", "M001/S01/T05"]);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind = 'task'
  `).get()?.["count"], 1, "only the corroborating sibling's own row exists");
});

test("without sibling corroboration a bare legacy-complete descendant is unresolved", (t) => {
  openFixture(t);
  db().exec(`
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md
    ) VALUES (
      'M001', 'S01', 'T06', 'Unsubstantiated straggler', 'complete',
      '2026-07-04T00:00:00.000Z', 'Finished', 'Historical completion', '', ''
    );
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/corroboration/unsubstantiated"),
    milestoneId: "M001",
  });

  // #2313: missing canonical open-item authority is restored first; #2002's
  // descendant atomicity is unchanged — T03 (unsupported evidence) and T06
  // (bare, unverified) are unresolved, so the evidence-backed T01/T02 are
  // reported unresolved too and no descendant Task is written.
  assert.deepEqual(result.repaired, ["M001", "M001/S01"]);
  assert.deepEqual(
    [...result.unresolved].sort(),
    ["M001/S01/T01", "M001/S01/T02", "M001/S01/T03", "M001/S01/T06"],
  );
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND item_kind = 'task'
  `).get()?.["count"], 0);
});

// ── Missing canonical Milestone authority adoption (#2313) ──────────────────

test("repairMilestoneLifecycleShadowsForward adopts a missing canonical Milestone as ready when legacy status is open", (t) => {
  openFixture(t);
  db().exec(`
    DELETE FROM tasks WHERE id = 'T03';
    UPDATE slices
    SET status = 'complete', completed_at = '2026-07-04T00:00:00.000Z',
        full_summary_md = '# S01 summary'
    WHERE milestone_id = 'M001' AND id = 'S01';
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/open-milestone/M001"),
    milestoneId: "M001",
  });

  assert.deepEqual([...result.repaired].sort(), ["M001", "M001/S01", "M001/S01/T01", "M001/S01/T02"].sort());
  assert.deepEqual(result.unresolved, []);
  assert.equal(db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
      AND slice_id IS NULL AND task_id IS NULL
  `).get()?.["lifecycle_status"], "ready");
  // The legacy hierarchy row is preserved untouched — no completion is claimed.
  assert.equal(db().prepare("SELECT status FROM milestones WHERE id = 'M001'").get()?.["status"], "active");
});

test("the adopted open-item authority no-ops on a fresh invocation and replays on the same key", (t) => {
  openFixture(t);
  db().exec("DELETE FROM tasks WHERE id = 'T03'");
  const first = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/adopt-replay/M001"),
    milestoneId: "M001",
  });
  assert.deepEqual([...first.repaired].sort(), ["M001", "M001/S01", "M001/S01/T01", "M001/S01/T02"].sort());
  const operationsAfterFirst = db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'lifecycle.shadow.repair'
  `).get()?.["count"];

  // Same invocation key: every committed step is idempotent — the canonical
  // rows now exist, so the authority adoption no-ops and the descendant pass
  // finds nothing in scope. No new operations may be written.
  const replayed = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/adopt-replay/M001"),
    milestoneId: "M001",
  });
  assert.deepEqual(replayed, { repaired: [], unresolved: [] });
  assert.deepEqual(
    db().prepare(`
      SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'lifecycle.shadow.repair'
    `).get()?.["count"],
    operationsAfterFirst,
  );

  // A fresh invocation finds the canonical rows present and adopts nothing.
  const fresh = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/adopt-replay/M001/fresh"),
    milestoneId: "M001",
  });
  assert.deepEqual(fresh.repaired, []);
  assert.deepEqual(fresh.unresolved, []);
  assert.equal(
    db().prepare(`
      SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'lifecycle.shadow.repair'
    `).get()?.["count"],
    operationsAfterFirst,
  );
});

test("a legacy-complete Milestone without a canonical row is not adopted as ready", (t) => {
  openFixture(t);
  db().exec(`
    DELETE FROM tasks WHERE id = 'T03';
    UPDATE slices
    SET status = 'complete', completed_at = '2026-07-04T00:00:00.000Z',
        full_summary_md = '# S01 summary'
    WHERE milestone_id = 'M001' AND id = 'S01';
    UPDATE milestones
    SET status = 'complete', completed_at = '2026-07-05T00:00:00.000Z'
    WHERE id = 'M001';
  `);

  const result = repairMilestoneLifecycleShadowsForward({
    invocation: invocation("shadow-repair/legacy-complete-milestone/M001"),
    milestoneId: "M001",
  });

  // Terminal Milestone authority belongs to closeout adoption, not to the
  // open-authority repair — no `ready` row may be minted.
  assert.ok(!result.repaired.includes("M001"));
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
  `).get()?.["count"], 0);
});

test("gsd_slice_complete restores the missing Milestone authority and completes the slice (#2313)", async (t) => {
  const basePath = openSliceCompletionFixture(t);
  const attemptsBefore = db().prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.["count"];
  const resultsBefore = db().prepare("SELECT COUNT(*) AS count FROM workflow_attempt_results").get()?.["count"];

  const result = await handleCompleteSlice({
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Historical slice",
    oneLiner: "Completed the historical slice",
    narrative: "Legacy hierarchy completed before canonical authority existed.",
    uatContent: "## Smoke Test\n\nRun the test suite and verify all assertions pass.\n",
  }, basePath, invocation("shadow-repair/slice-complete/M001"));

  assert.ok(!("error" in result), `slice completion should proceed: ${"error" in result ? result.error : ""}`);
  const sliceStatus = db().prepare("SELECT status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'")
    .get()?.["status"];
  assert.equal(sliceStatus, "complete");
  assert.equal(db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
      AND slice_id IS NULL AND task_id IS NULL
  `).get()?.["lifecycle_status"], "ready", "the repair must restore the Milestone authority");
  assert.equal(db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S01'
  `).get()?.["lifecycle_status"], "completed");
  // Existing canonical completion evidence is preserved untouched.
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.["count"], attemptsBefore);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_attempt_results").get()?.["count"], resultsBefore);
});
