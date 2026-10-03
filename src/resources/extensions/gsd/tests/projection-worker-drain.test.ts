// Project/App: gsd-pi
// File Purpose: Projection Worker per-key drain: renderer registry, retry and dead_letter, target roots.

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _setManagedMutationBoundaryForTest } from "../atomic-write.ts";
import { formatTextStatus } from "../commands/handlers/core.ts";
import { flushWorkflowProjections } from "../projection-flush.ts";
import { checkProjectionWork } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { _getAdapter } from "../gsd-db.ts";
import { resolveMilestoneFile } from "../paths.ts";
import {
  drainProjectionWork,
  readProjectionRootReceipts,
  readProjectionWorkBacklog,
  rebuildMarkdownProjectionsFromDb,
} from "../projection-worker.ts";
import { PROJECTION_LOCK_TRANSIENT_BACKOFF_MS } from "../recovery-policy.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { seedLifecycle } from "./db-authority-gate.ts";
import {
  createWorkflowAuthorityFixture,
  type WorkflowAuthorityFixture,
} from "./workflow-authority-fixture.ts";

let fixture: WorkflowAuthorityFixture | undefined;

afterEach(() => {
  _setManagedMutationBoundaryForTest(null);
  fixture?.cleanup();
  fixture = undefined;
  invalidateStateCache();
});

type WorkRow = {
  projection_work_id: string;
  delivery_state: string;
  attempt_count: number;
  last_error: string;
  next_attempt_at: string;
  rendered_content_hash: string | null;
};

function work(key: string): WorkRow {
  const row = _getAdapter()!.prepare(`
    SELECT projection_work_id, delivery_state, attempt_count, last_error,
           next_attempt_at, rendered_content_hash
    FROM workflow_projection_work WHERE projection_key = :key
  `).get({ ":key": key }) as WorkRow | undefined;
  assert.ok(row, `projection work ${key} exists`);
  return row;
}

const LATER = () => new Date(Date.now() + 86_400_000);

test("a row of a kind with no registered renderer is never settled as rendered", async () => {
  fixture = await createWorkflowAuthorityFixture();
  const base = fixture.root;
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
    "unregistered",
    "unregistered-kind",
    "lifecycle/m001/s02",
  );

  const drained = await drainProjectionWork(base, { now: LATER() });
  const rebuilt = await rebuildMarkdownProjectionsFromDb(base);

  assert.equal(drained.delivered, 0);
  assert.equal(rebuilt.delivered, 0, "the full sweep does not settle it either");
  assert.deepEqual(
    { ...work("lifecycle/m001/s02"), projection_work_id: undefined },
    {
      projection_work_id: undefined,
      delivery_state: "pending",
      attempt_count: 0,
      last_error: "",
      next_attempt_at: "",
      rendered_content_hash: null,
    },
  );
  assert.deepEqual(
    readProjectionWorkBacklog().map(({ projectionKey, deliveryState, hasRenderer }) =>
      ({ projectionKey, deliveryState, hasRenderer })),
    [{ projectionKey: "lifecycle/m001/s02", deliveryState: "pending", hasRenderer: false }],
    "the stuck row is visible",
  );
});

test("a key that keeps failing retries on the backoff schedule and then dead-letters", async () => {
  fixture = await createWorkflowAuthorityFixture();
  const base = fixture.root;
  const roadmapPath = resolveMilestoneFile(base, "M001", "ROADMAP");
  assert.equal(roadmapPath, null, "no ROADMAP is rendered yet");
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.endsWith("ROADMAP.md")) throw new Error("disk refuses ROADMAP");
  });
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
    "always-fails",
    "slice-lifecycle",
    "lifecycle/m001/s02",
  );

  const waits: number[] = [];
  let now = new Date();
  while (work("lifecycle/m001/s02").delivery_state === "pending") {
    const drained = await drainProjectionWork(base, { now });
    assert.equal(drained.delivered, 0);
    assert.match(drained.errors.join("\n"), /disk refuses ROADMAP/);
    const row = work("lifecycle/m001/s02");
    if (row.delivery_state !== "pending") break;
    const next = new Date(row.next_attempt_at);
    waits.push(next.getTime() - now.getTime());
    assert.equal((await drainProjectionWork(base, { now: new Date(next.getTime() - 1) })).errors.length, 0,
      "not retried before the retry time");
    now = next;
  }

  assert.deepEqual(waits, [...PROJECTION_LOCK_TRANSIENT_BACKOFF_MS]);
  const dead = work("lifecycle/m001/s02");
  assert.equal(dead.delivery_state, "dead_letter");
  assert.equal(dead.attempt_count, PROJECTION_LOCK_TRANSIENT_BACKOFF_MS.length + 1);
  assert.match(dead.last_error, /disk refuses ROADMAP/);
  assert.equal(dead.rendered_content_hash, null);
  assert.deepEqual((await drainProjectionWork(base, { now: LATER() })).errors, [], "dead work is not retried");
  assert.deepEqual(
    readProjectionWorkBacklog().map(({ projectionKey, deliveryState }) => ({ projectionKey, deliveryState })),
    [{ projectionKey: "lifecycle/m001/s02", deliveryState: "dead_letter" }],
  );
});

test("worktree and project root each get a rendered state", async () => {
  fixture = await createWorkflowAuthorityFixture();
  const root = fixture.root;
  const worktree = join(root, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
    "two-roots",
    "slice-lifecycle",
    "lifecycle/m001/s02",
  );
  assert.equal(resolveMilestoneFile(root, "M001", "ROADMAP"), null);
  assert.equal(resolveMilestoneFile(worktree, "M001", "ROADMAP"), null);

  const drained = await drainProjectionWork(worktree);

  assert.deepEqual(drained.errors, []);
  assert.equal(drained.delivered, 1);
  const row = work("lifecycle/m001/s02");
  assert.equal(row.delivery_state, "rendered", "the row settles at the project root");
  assert.match(String(row.rendered_content_hash), /^sha256:[0-9a-f]{64}$/);
  const rootRoadmap = resolveMilestoneFile(root, "M001", "ROADMAP");
  const worktreeRoadmap = resolveMilestoneFile(worktree, "M001", "ROADMAP");
  assert.ok(rootRoadmap && existsSync(rootRoadmap), "project root ROADMAP is rendered");
  assert.ok(worktreeRoadmap && existsSync(worktreeRoadmap), "worktree ROADMAP is rendered");
  assert.notEqual(rootRoadmap, worktreeRoadmap);
  assert.deepEqual(
    readProjectionRootReceipts(worktree),
    { [row.projection_work_id]: row.rendered_content_hash },
    "the worktree records the same file-set hash for the same row",
  );
});

test("doctor and status show failed and unrendered Projection Work, and repair delivers due work", async () => {
  fixture = await createWorkflowAuthorityFixture();
  const base = fixture.root;
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.endsWith("ROADMAP.md")) throw new Error("disk refuses ROADMAP");
  });
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
    "doctor-fails",
    "slice-lifecycle",
    "lifecycle/m001/s02",
  );
  seedLifecycle(
    { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "in_progress" },
    "doctor-state",
    "state",
    "project/authority",
  );
  // A failure at a later time puts its retry time far past the repair drain below.
  await drainProjectionWork(base, { now: LATER() });

  const issues: DoctorIssue[] = [];
  await checkProjectionWork(base, issues, [], false);
  assert.deepEqual(
    issues.map(({ severity, code, unitId }) => ({ severity, code, unitId })),
    [
      { severity: "warning", code: "projection_work_pending", unitId: "lifecycle/m001/s02" },
      { severity: "info", code: "projection_work_unrendered", unitId: "projection-work" },
    ],
  );
  assert.match(issues[0]!.message, /failed 1 time\(s\): .*disk refuses ROADMAP/);
  assert.match(issues[1]!.message, /state: 1/);
  assert.match(
    formatTextStatus(await deriveState(base), base),
    /Projection Work not rendered: 0 pending, 1 retrying, 0 dead-lettered, 1 with no renderer/,
  );

  _setManagedMutationBoundaryForTest(null);
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" },
    "doctor-due",
    "slice-lifecycle",
    "lifecycle/m001/s01",
  );
  const repaired: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkProjectionWork(base, repaired, fixes, true);

  assert.deepEqual(fixes, ["delivered 1 Projection Work row(s)"], "repair delivers the due row");
  assert.equal(work("lifecycle/m001/s01").delivery_state, "rendered");
  assert.deepEqual(
    repaired.map(({ code, unitId }) => ({ code, unitId })),
    [
      { code: "projection_work_pending", unitId: "lifecycle/m001/s02" },
      { code: "projection_work_unrendered", unitId: "projection-work" },
    ],
    "the failed row waits for its retry time and stays visible",
  );
});

test("a failing row of another milestone does not make a milestone flush stale", async () => {
  fixture = await createWorkflowAuthorityFixture();
  const base = fixture.root;
  // M002 is not in the database, so its renderer fails on every attempt.
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" },
    "other-milestone",
    "slice-lifecycle",
    "lifecycle/m002/s01",
  );

  assert.deepEqual(await flushWorkflowProjections(base, { milestoneId: "M001" }), {
    milestoneId: "M001",
    stale: false,
    superseded: false,
  });
  const failed = work("lifecycle/m002/s01");
  assert.equal(failed.attempt_count, 1, "the flush drained the M002 row");
  assert.match(failed.last_error, /milestone m002 is not in the database/);

  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.endsWith("-PLAN.md")) throw new Error("disk refuses PLAN");
  });
  seedLifecycle(
    { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed" },
    "own-milestone",
    "slice-lifecycle",
    "lifecycle/m001/s01",
  );
  assert.equal(
    (await flushWorkflowProjections(base, { milestoneId: "M001" })).stale,
    true,
    "a failing M001 row makes the M001 flush stale",
  );
  assert.match(work("lifecycle/m001/s01").last_error, /disk refuses PLAN/);
});
