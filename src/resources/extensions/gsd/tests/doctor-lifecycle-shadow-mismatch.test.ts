// Project/App: gsd-pi
// File Purpose: Doctor visibility for legacy/canonical lifecycle shadow drift (#2440).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import type { DomainJsonValue } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "../db/writers/lifecycle-commands.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { reportMilestoneLifecycleShadowDrift } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { repairMilestoneShadowsForReopen } from "../lifecycle-shadow-repair-domain-operation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter, "expected an open database");
  return adapter;
}

function seedLifecycle(
  item: {
    itemKind: "milestone" | "slice" | "task";
    milestoneId: string;
    sliceId?: string;
    taskId?: string;
  },
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
    operationType: "test.shadow-doctor.seed",
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "test",
    payload,
  }, (context) => {
    adoptOrTransitionLifecycle(context, { ...item, lifecycleStatus: status });
    return {
      events: [{
        eventType: "test.shadow-doctor.seeded",
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

function openDriftFixture(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-shadow-doctor-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  // #2440 drift shape: legacy hierarchy went terminal through the legacy path
  // while the canonical lifecycle rows stayed `ready`.
  db().exec(`
    INSERT INTO milestones (id, title, status, completed_at, created_at)
    VALUES ('M001', 'Drifted milestone', 'complete', '2026-07-05T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, completed_at, full_summary_md, sequence, created_at)
    VALUES (
      'M001', 'S01', 'Drifted slice', 'complete',
      '2026-07-04T00:00:00.000Z', '# S01 summary', 1, '2026-07-01T00:00:00.000Z'
    );
    INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, completed_at,
      one_liner, narrative, verification_result, full_summary_md, sequence
    ) VALUES (
      'M001', 'S01', 'T01', 'Drifted task', 'complete',
      '2026-07-03T00:00:00.000Z', 'Finished', 'Historical completion', 'passed', '# T01 summary', 1
    );
  `);
  seedLifecycle({ itemKind: "milestone", milestoneId: "M001" }, "completed", "shadow-doctor/milestone");
  seedLifecycle({ itemKind: "slice", milestoneId: "M001", sliceId: "S01" }, "ready", "shadow-doctor/slice");
  seedLifecycle(
    { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    "ready",
    "shadow-doctor/task",
  );
  t.after(closeDatabase);
}

test("doctor lists drifted hierarchy rows as lifecycle_shadow_mismatch", (t) => {
  openDriftFixture(t);

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);

  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.deepEqual(drifted.map((issue) => issue.unitId).sort(), ["M001/S01", "M001/S01/T01"]);
  const sliceIssue = drifted.find((issue) => issue.unitId === "M001/S01")!;
  assert.equal(sliceIssue.scope, "slice");
  assert.equal(sliceIssue.severity, "error");
  assert.ok(sliceIssue.message.includes('"complete"'), "message names the legacy status");
  assert.ok(sliceIssue.message.includes('"ready"'), "message names the canonical status");
  // The milestone itself has terminal parity — it must not be reported.
  assert.equal(drifted.find((issue) => issue.unitId === "M001"), undefined);
});

test("matched and semantic-match rows are not reported", (t) => {
  openDriftFixture(t);
  // Converge via the real reopen-scoped repair, exactly as the reopen path does.
  const repair = repairMilestoneShadowsForReopen({
    invocation: {
      idempotencyKey: "shadow-doctor/converge",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "shadow-doctor-test",
      traceId: "trace/shadow-doctor",
      turnId: "turn/shadow-doctor",
    },
    milestoneId: "M001",
  });
  assert.deepEqual(repair.unresolved, []);
  assert.ok(repair.repaired.length > 0);

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  assert.equal(issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch").length, 0);
});

test("a foreign-project-only lifecycle row is not reported as drift", (t) => {
  openDriftFixture(t);
  // A stale imported row from another project with no legacy hierarchy row of
  // its own must not surface as a local status_mismatch.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'decoy-foreign', 'decoy-project', 'slice', 'M001', 'S99', NULL,
      'completed', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      'decoy-op', 1, 0
    )
  `).run();
  db().exec("PRAGMA foreign_keys = ON");

  const issues: DoctorIssue[] = [];
  reportMilestoneLifecycleShadowDrift(issues);
  const drifted = issues.filter((issue) => issue.code === "lifecycle_shadow_mismatch");
  assert.deepEqual(drifted.map((issue) => issue.unitId).sort(), ["M001/S01", "M001/S01/T01"]);
});
