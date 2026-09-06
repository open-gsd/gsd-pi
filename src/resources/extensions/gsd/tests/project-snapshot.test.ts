// Project/App: gsd-pi
// File Purpose: readProjectSnapshotFromDb — DB-authoritative project snapshot
// reads (#2102). Pins the exact DbProjectSnapshot key set, the seeded
// authority/progress/blocker/question/verification/milestone sections, byte
// determinism at a stable revision, milestone registry truncation, open-item
// ordering, and the missing-DB null contract.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  _getAdapter,
  closeDatabase,
  getAllMilestones,
  getProjectAuthorityRow,
  getSchemaVersion,
  insertMilestone,
  setMilestoneQueueOrder,
  transaction,
} from "../gsd-db.ts";
import { deriveState, getDeriveTelemetry, invalidateStateCache, resetDeriveTelemetry } from "../state.ts";
import { readProgressFromDb } from "../state/progress-from-db.ts";
import {
  MAX_SNAPSHOT_MILESTONES,
  readProjectSnapshotFromDb,
} from "../state/project-snapshot.ts";
import {
  createWorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

// Provenance seeds. workflow_blockers / workflow_open_questions reference
// workflow_operations and workflow_item_lifecycles, so the snapshot seeds
// must build that minimal provenance chain first (same shape the foundation
// schema tests use). Revisions sit far above the fixture's authority revision
// so the seed never collides with real writer operations.
const SEED_REVISION_BASE = 910_001;

function fixtureProjectId(): string {
  const authority = getProjectAuthorityRow();
  assert.ok(authority, "fixture project_authority row should exist");
  return authority.projectId;
}

function seedOperation(operationId: string, revision: number): void {
  _getAdapter()!.prepare(
    `INSERT INTO workflow_operations (
       operation_id, project_id, operation_type, idempotency_key,
       expected_revision, resulting_revision,
       expected_authority_epoch, resulting_authority_epoch,
       actor_type, actor_id, source_transport, request_hash, created_at
     ) VALUES (?, ?, 'snapshot-test', ?, ?, ?, 0, 0, 'agent', 'test', 'test', ?, '2026-09-05T00:00:00.000Z')`,
  ).run(
    operationId,
    fixtureProjectId(),
    `key-${operationId}`,
    revision - 1,
    revision,
    `hash-${operationId}`,
  );
}

function seedMilestoneLifecycle(
  lifecycleId: string,
  operationId: string,
  revision: number,
): void {
  _getAdapter()!.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
       created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES (?, ?, 'milestone', 'M001', 'in_progress', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', ?, ?, 0)`,
  ).run(lifecycleId, fixtureProjectId(), operationId, revision);
}

function seedBlocker(input: {
  blockerId: string;
  lifecycleId: string;
  operationId: string;
  revision: number;
  kind?: string;
  openedAt?: string;
}): void {
  _getAdapter()!.prepare(
    `INSERT INTO workflow_blockers (
       blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
       blocker_status, description, requested_action, opened_at,
       opened_operation_id, opened_project_revision, opened_authority_epoch
     ) VALUES (?, ?, ?, ?, 'user', 'open', ?, ?, ?, ?, ?, 0)`,
  ).run(
    input.blockerId,
    fixtureProjectId(),
    input.lifecycleId,
    input.kind ?? "ambiguous_intent",
    `${input.blockerId} description`,
    `${input.blockerId} requested action`,
    input.openedAt ?? "2026-09-05T00:00:00.000Z",
    input.operationId,
    input.revision,
  );
}

function seedQuestion(input: {
  questionId: string;
  lifecycleId: string;
  operationId: string;
  revision: number;
  text: string;
  createdAt: string;
}): void {
  // The initial-state trigger requires created/last provenance to match and
  // created_at == updated_at for a question that begins open.
  _getAdapter()!.prepare(
    `INSERT INTO workflow_open_questions (
       question_id, project_id, lifecycle_id, question_text, question_status,
       state_version, created_at, updated_at,
       created_operation_id, created_project_revision, created_authority_epoch,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, 0, ?, ?, 0)`,
  ).run(
    input.questionId,
    fixtureProjectId(),
    input.lifecycleId,
    input.text,
    input.createdAt,
    input.createdAt,
    input.operationId,
    input.revision,
    input.operationId,
    input.revision,
  );
}

function seedVerificationRows(): void {
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO assessments (path, milestone_id, status, scope, full_content, created_at)
     VALUES
       ('snapshot-assess-pass', 'M001', 'pass', 'slice', '', '2026-09-05T00:00:00.000Z'),
       ('snapshot-assess-fail', 'M001', 'FAIL', 'slice', '', '2026-09-05T00:00:00.000Z')`,
  ).run();
  // Tasks (M001, S01, T01) and (M001, S02, T01) exist in the fixture; the
  // verification_evidence FK targets that composite key.
  db.prepare(
    `INSERT INTO verification_evidence (
       task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
     ) VALUES
       ('T01', 'S01', 'M001', 'npm test', 0, 'passed', 12, '2026-09-05T00:00:00.000Z'),
       ('T01', 'S02', 'M001', 'npm test', 1, 'failed', 34, '2026-09-05T00:00:00.000Z'),
       ('T01', 'S02', 'M001', 'npm run check', 1, 'Failed', 56, '2026-09-05T00:00:00.000Z')`,
  ).run();
}

/** Seeds blockers/questions with deliberately mixed insert order + revisions. */
function seedSnapshotOpenItems(): void {
  transaction(() => {
    seedOperation("op-snap-a", SEED_REVISION_BASE);
    seedOperation("op-snap-b", SEED_REVISION_BASE + 1);
    seedMilestoneLifecycle("life-snap", "op-snap-a", SEED_REVISION_BASE);

    // Blockers: inserted out of order; B-snap-zz carries the lower revision so
    // ordering must come from (opened_project_revision, blocker_id), not
    // insertion order or id alone.
    seedBlocker({
      blockerId: "B-snap-zz",
      lifecycleId: "life-snap",
      operationId: "op-snap-a",
      revision: SEED_REVISION_BASE,
      openedAt: "2026-09-05T00:00:03.000Z",
    });
    seedBlocker({
      blockerId: "B-snap-aa",
      lifecycleId: "life-snap",
      operationId: "op-snap-b",
      revision: SEED_REVISION_BASE + 1,
      openedAt: "2026-09-05T00:00:01.000Z",
    });
    // Same revision as B-snap-aa: id is the tiebreaker.
    seedBlocker({
      blockerId: "B-snap-ab",
      lifecycleId: "life-snap",
      operationId: "op-snap-b",
      revision: SEED_REVISION_BASE + 1,
      openedAt: "2026-09-05T00:00:02.000Z",
    });

    // Questions: inserted out of order; ordering must come from
    // (created_at, question_id), not insertion order.
    seedQuestion({
      questionId: "Q-snap-later",
      lifecycleId: "life-snap",
      operationId: "op-snap-a",
      revision: SEED_REVISION_BASE,
      text: "Which storage engine should back the queue?",
      createdAt: "2026-09-05T00:00:09.000Z",
    });
    seedQuestion({
      questionId: "Q-snap-b",
      lifecycleId: "life-snap",
      operationId: "op-snap-a",
      revision: SEED_REVISION_BASE,
      text: "Same-timestamp question B",
      createdAt: "2026-09-05T00:00:05.000Z",
    });
    seedQuestion({
      questionId: "Q-snap-a",
      lifecycleId: "life-snap",
      operationId: "op-snap-a",
      revision: SEED_REVISION_BASE,
      text: "Same-timestamp question A",
      createdAt: "2026-09-05T00:00:05.000Z",
    });
  });
}

test("readProjectSnapshotFromDb emits exactly the DbProjectSnapshot key set", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  const snapshot = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "authority",
    "blockers",
    "capturedAt",
    "current",
    "milestones",
    "openQuestions",
    "progress",
    "verification",
  ]);
  assert.deepEqual(Object.keys(snapshot.authority), ["projectId", "schemaVersion", "revision", "authorityEpoch"]);
  assert.deepEqual(Object.keys(snapshot.current), [
    "activeMilestone",
    "activeSlice",
    "activeTask",
    "phase",
    "nextAction",
  ]);
  assert.deepEqual(Object.keys(snapshot.progress), ["milestones", "slices", "tasks"]);
  assert.deepEqual(Object.keys(snapshot.progress.milestones), ["total", "done", "active", "pending", "parked"]);
  assert.deepEqual(Object.keys(snapshot.progress.slices), ["total", "done", "active", "pending"]);
  assert.deepEqual(Object.keys(snapshot.progress.tasks), ["total", "done", "pending"]);
  assert.deepEqual(Object.keys(snapshot.milestones), ["items", "truncated"]);
  assert.deepEqual(Object.keys(snapshot.verification), ["assessments", "evidence"]);
  assert.deepEqual(Object.keys(snapshot.verification.assessments), ["total", "pass", "fail"]);
  assert.deepEqual(Object.keys(snapshot.verification.evidence), ["total", "passed", "failed"]);
});

test("readProjectSnapshotFromDb assembles authority, current, progress, open items, verification, and milestones", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  seedSnapshotOpenItems();
  seedVerificationRows();

  const snapshot = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(snapshot);
  const state = await deriveState(fixture.root);

  const authorityRow = getProjectAuthorityRow();
  assert.ok(authorityRow);
  assert.equal(snapshot.authority.projectId, authorityRow.projectId);
  assert.ok(snapshot.authority.projectId.length > 0, "projectId should be the real authority id");
  assert.equal(snapshot.authority.revision, authorityRow.revision);
  assert.equal(snapshot.authority.authorityEpoch, authorityRow.authorityEpoch);
  assert.equal(snapshot.authority.schemaVersion, getSchemaVersion());
  assert.equal(typeof snapshot.authority.schemaVersion, "number");

  assert.deepEqual(snapshot.current.activeMilestone, { id: "M001", title: "Authority Fixture" });
  assert.deepEqual(snapshot.current.activeSlice, { id: "S02", title: "Ready dependent slice" });
  assert.deepEqual(snapshot.current.activeTask, { id: "T01", title: "Ready task" });
  // The current section must be the same derivation the canonical state
  // reader serves, not a snapshot-specific re-implementation.
  assert.deepEqual(snapshot.current.activeMilestone, state.activeMilestone
    ? { id: state.activeMilestone.id, title: state.activeMilestone.title }
    : null);
  assert.deepEqual(snapshot.current.activeSlice, state.activeSlice
    ? { id: state.activeSlice.id, title: state.activeSlice.title }
    : null);
  assert.deepEqual(snapshot.current.activeTask, state.activeTask
    ? { id: state.activeTask.id, title: state.activeTask.title }
    : null);
  assert.equal(snapshot.current.phase, state.phase);
  assert.equal(typeof snapshot.current.nextAction, "string");
  assert.ok(snapshot.current.nextAction.length > 0);

  assert.deepEqual(snapshot.progress.milestones, { total: 1, done: 0, active: 1, pending: 0, parked: 0 });
  assert.deepEqual(snapshot.progress.slices, { total: 2, done: 1, active: 0, pending: 1 });
  assert.deepEqual(snapshot.progress.tasks, { total: 2, done: 1, pending: 1 });

  assert.equal(snapshot.blockers.length, 3);
  assert.deepEqual(
    snapshot.blockers.map((b) => b.blockerId),
    ["B-snap-zz", "B-snap-aa", "B-snap-ab"],
  );
  assert.deepEqual(snapshot.blockers[0], {
    blockerId: "B-snap-zz",
    blockerKind: "ambiguous_intent",
    resolutionOwner: "user",
    description: "B-snap-zz description",
    requestedAction: "B-snap-zz requested action",
    openedAt: "2026-09-05T00:00:03.000Z",
    openedProjectRevision: SEED_REVISION_BASE,
  });

  assert.equal(snapshot.openQuestions.length, 3);
  assert.deepEqual(
    snapshot.openQuestions.map((q) => q.questionId),
    ["Q-snap-a", "Q-snap-b", "Q-snap-later"],
  );
  assert.deepEqual(snapshot.openQuestions[2], {
    questionId: "Q-snap-later",
    questionText: "Which storage engine should back the queue?",
    createdAt: "2026-09-05T00:00:09.000Z",
  });

  assert.deepEqual(snapshot.verification, {
    assessments: { total: 2, pass: 1, fail: 1 },
    evidence: { total: 3, passed: 1, failed: 2 },
  });

  assert.equal(snapshot.milestones.truncated, false);
  assert.deepEqual(snapshot.milestones.items, [
    { id: "M001", title: "Authority Fixture", status: "active", sequence: 0 },
  ]);

  assert.equal(typeof snapshot.capturedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(snapshot.capturedAt)), "capturedAt should be an ISO timestamp");
});

test("readProjectSnapshotFromDb is byte-deterministic at a stable revision", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());
  seedSnapshotOpenItems();

  const first = await readProjectSnapshotFromDb(fixture.root);
  const second = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(first);
  assert.ok(second);

  // capturedAt legitimately moves between reads; everything else must not.
  const firstPayload = JSON.stringify({ ...first, capturedAt: "<capturedAt>" });
  const secondPayload = JSON.stringify({ ...second, capturedAt: "<capturedAt>" });
  assert.equal(firstPayload, secondPayload);
});

test("readProjectSnapshotFromDb truncates the milestone registry beyond the cap", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  // Fixture has M001; M002..M051 push the registry past the 50-item cap.
  // Milestones default to sequence 0, so registry order is id-lexicographic
  // and M051 is the row dropped by truncation.
  transaction(() => {
    for (let n = 2; n <= 51; n += 1) {
      insertMilestone({
        id: `M${String(n).padStart(3, "0")}`,
        title: `Extra milestone ${n}`,
        status: "pending",
      });
    }
  });

  const snapshot = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(snapshot);

  assert.equal(MAX_SNAPSHOT_MILESTONES, 50);
  assert.equal(snapshot.milestones.truncated, true);
  assert.equal(snapshot.milestones.items.length, 50);
  assert.equal(snapshot.milestones.items[0]?.id, "M001");
  assert.equal(snapshot.milestones.items[49]?.id, "M050");
  assert.equal(
    snapshot.milestones.items.some((m) => m.id === "M051"),
    false,
    "the milestone past the cap must not appear in the registry",
  );
  // Counts stay project-wide even when the registry is truncated.
  assert.deepEqual(snapshot.progress.milestones, { total: 51, done: 0, active: 1, pending: 50, parked: 0 });
});

test("readProjectSnapshotFromDb returns null when no database exists", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gsd-snapshot-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The reader must not ride on a global handle left open by another test's
  // fixture, and must not create the database as a side effect.
  closeDatabase();

  const snapshot = await readProjectSnapshotFromDb(root);

  assert.equal(snapshot, null);
  assert.equal(existsSync(join(root, ".gsd", "gsd.db")), false, "missing DB must not be created");
});

test("snapshot and progress reads never mutate milestone sequence from QUEUE-ORDER.json (runtime derive still repairs)", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  transaction(() => {
    insertMilestone({ id: "M002", title: "Second", status: "pending" });
    insertMilestone({ id: "M003", title: "Third", status: "pending" });
  });
  // DB-authoritative order differs from the projection file on purpose.
  setMilestoneQueueOrder(["M002", "M001", "M003"]);
  writeFileSync(
    join(fixture.root, ".gsd", "QUEUE-ORDER.json"),
    JSON.stringify({ order: ["M001", "M002", "M003"] }),
  );

  const snapshot = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(snapshot);
  assert.deepEqual(
    getAllMilestones().map((m) => m.id),
    ["M002", "M001", "M003"],
    "snapshot read must not mirror QUEUE-ORDER.json into DB sequence",
  );
  assert.deepEqual(
    snapshot.milestones.items.map((m) => m.id),
    ["M002", "M001", "M003"],
    "registry must report DB-authoritative order, not the projection file",
  );

  const progress = await readProgressFromDb(fixture.root);
  assert.ok(progress);
  assert.deepEqual(
    getAllMilestones().map((m) => m.id),
    ["M002", "M001", "M003"],
    "progress read must not mirror QUEUE-ORDER.json into DB sequence",
  );

  // The runtime derive path (sync enabled) still repairs sequence from the
  // file. deriveState is cache-first, so invalidate like a fresh runtime
  // derive (the read above populated the cache).
  invalidateStateCache();
  await deriveState(fixture.root);
  assert.deepEqual(
    getAllMilestones().map((m) => m.id),
    ["M001", "M002", "M003"],
    "runtime derive must keep the queue-order projection repair",
  );
});

/** Same mechanism as progress-from-db.test.ts: bump the authority revision when
 *  the hierarchy-counts query runs, through the shared adapter. */
function changeAuthorityDuringCounts(
  t: TestContext,
  limit: number,
): () => number {
  const adapter = _getAdapter();
  assert.ok(adapter);
  const originalPrepare = adapter.prepare.bind(adapter);
  let changes = 0;

  adapter.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("AS completed") || !sql.includes("FROM milestones")) return statement;
    return {
      ...statement,
      get(...params: unknown[]) {
        if (changes < limit) {
          changes++;
          originalPrepare("UPDATE milestones SET title = ? WHERE id = 'M001'")
            .run(`Authority revision ${changes}`);
          originalPrepare("UPDATE project_authority SET revision = revision + 1 WHERE singleton = 1")
            .run();
        }
        return statement.get(...params);
      },
    } as typeof statement;
  };
  t.after(() => {
    adapter.prepare = originalPrepare;
  });
  return () => changes;
}

test("readProjectSnapshotFromDb retries when the authority revision moves during the counts read", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  resetDeriveTelemetry();
  const changes = changeAuthorityDuringCounts(t, 1);

  const snapshot = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(snapshot);
  assert.equal(changes(), 1, "the revision bump should have fired exactly once");
  assert.equal(getDeriveTelemetry().dbDeriveCount, 2, "a moved stability token must trigger a second derive");
  assert.ok(snapshot.authority.revision >= 1, "the returned snapshot reflects the moved revision");
});

test("readProjectSnapshotFromDb returns the last attempt during sustained revision movement", async (t) => {
  const fixture = await createWorkflowAuthorityFixture();
  t.after(() => fixture.cleanup());

  resetDeriveTelemetry();
  changeAuthorityDuringCounts(t, 3);

  const snapshot = await readProjectSnapshotFromDb(fixture.root);
  assert.ok(snapshot);
  assert.equal(
    getDeriveTelemetry().dbDeriveCount,
    3,
    "sustained movement must stop at MAX_REVISION_ATTEMPTS and return the last attempt",
  );
});

test("readProjectSnapshotFromDb reopens the requested project instead of reusing another global DB", async (t) => {
  const first = await createWorkflowAuthorityFixture();
  const second = await createWorkflowAuthorityFixture();
  t.after(() => {
    first.cleanup();
    second.cleanup();
  });

  first.reopen();
  const firstAuthority = getProjectAuthorityRow();
  assert.ok(firstAuthority);

  const secondSnapshot = await readProjectSnapshotFromDb(second.root);
  assert.ok(secondSnapshot);

  assert.notEqual(secondSnapshot.authority.projectId, firstAuthority.projectId);
  assert.equal(secondSnapshot.current.activeMilestone?.title, "Authority Fixture");
});

test("readProjectSnapshotFromDb returns null for a missing requested DB instead of reusing an open global DB", async (t) => {
  const existing = await createWorkflowAuthorityFixture();
  const missingRoot = join(tmpdir(), `gsd-project-snapshot-missing-${randomUUID()}`);
  mkdirSync(join(missingRoot, ".gsd"), { recursive: true });
  t.after(() => {
    existing.cleanup();
    rmSync(missingRoot, { recursive: true, force: true });
  });

  existing.reopen();
  const existingAuthority = getProjectAuthorityRow();
  assert.ok(existingAuthority);

  const missingSnapshot = await readProjectSnapshotFromDb(missingRoot);

  assert.equal(missingSnapshot, null);
});
