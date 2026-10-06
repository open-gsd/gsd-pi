// Project/App: gsd-pi
// File Purpose: Projection Worker per-key drain: renderer registry, retry and dead_letter, target roots.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _setManagedMutationBoundaryForTest } from "../atomic-write.ts";
import { formatTextStatus } from "../commands/handlers/core.ts";
import { flushWorkflowProjections } from "../projection-flush.ts";
import { checkEngineHealth, checkProjectionWork } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { _getAdapter, insertArtifact, insertMilestone } from "../gsd-db.ts";
import { resolveMilestoneFile, resolveSliceFile, resolveTaskFile } from "../paths.ts";
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
    FROM workflow_projection_work work WHERE projection_key = :key AND NOT EXISTS (
      SELECT 1 FROM workflow_projection_work successor
      WHERE successor.supersedes_projection_work_id = work.projection_work_id
    )
  `).get({ ":key": key }) as WorkRow | undefined;
  assert.ok(row, `projection work ${key} exists`);
  return row;
}

/**
 * The fixture saves a decision and a requirement, which enqueue a "decisions"
 * row and a "planning/requirements" row. Settle them so each test starts with
 * no backlog.
 */
async function createDrainedFixture(): Promise<WorkflowAuthorityFixture> {
  const created = await createWorkflowAuthorityFixture();
  try {
    const drained = await drainProjectionWork(created.root);
    assert.deepEqual(drained.errors, []);
    assert.deepEqual(readProjectionWorkBacklog(), []);
  } catch (error) {
    created.cleanup();
    throw error;
  }
  return created;
}

const LATER = () => new Date(Date.now() + 86_400_000);

const SLICE = { itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "in_progress" } as const;

function seed(kind: string, key: string): void {
  seedLifecycle(SLICE, key, kind, key);
}

/** Drain at each retry time until the row stops retrying. */
async function drainUntilDeadLetter(base: string, key: string): Promise<void> {
  let now = new Date();
  while (work(key).delivery_state === "pending") {
    await drainProjectionWork(base, { now });
    const next = work(key).next_attempt_at;
    if (next) now = new Date(next);
  }
  assert.equal(work(key).delivery_state, "dead_letter");
}

test("a row of a kind with no registered renderer is never settled as rendered", async () => {
  fixture = await createDrainedFixture();
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
  fixture = await createDrainedFixture();
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
  fixture = await createDrainedFixture();
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
  // The fixture decision and requirement rows also get a receipt. DECISIONS.md
  // and REQUIREMENTS.md are project-root files, so their path relative to the
  // worktree gives a different file-set hash.
  const {
    [work("decisions").projection_work_id]: decisionsReceipt,
    [work("planning/requirements").projection_work_id]: requirementsReceipt,
    ...receipts
  } = readProjectionRootReceipts(worktree);
  assert.match(String(decisionsReceipt), /^sha256:[0-9a-f]{64}$/);
  assert.match(String(requirementsReceipt), /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    receipts,
    { [row.projection_work_id]: row.rendered_content_hash },
    "the worktree records the same file-set hash for the same row",
  );
});

test("doctor and status show failed and unrendered Projection Work, and repair delivers due work", async () => {
  fixture = await createDrainedFixture();
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
    "doctor-unregistered",
    "unregistered-kind",
    "unregistered/thing",
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
  assert.match(issues[1]!.message, /unregistered-kind: 1/);
  assert.equal(issues[0]!.fixable, false, "a row that waits for its retry time is not fixable by a repair run");
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

  assert.deepEqual(
    fixes,
    ["delivered 2 Projection Work row(s)", "re-rendered missing projections for M001"],
    "repair delivers the due row and the work it enqueued for the missing ROADMAP",
  );
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
  fixture = await createDrainedFixture();
  const base = fixture.root;
  insertMilestone({ id: "M002", title: "Second", status: "queued", planning: { vision: "Ship the second." } });
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.includes("02-second") && path.endsWith("ROADMAP.md")) throw new Error("disk refuses M002 ROADMAP");
  });
  seed("milestone-lifecycle", "lifecycle/m002");

  assert.deepEqual(await flushWorkflowProjections(base, { milestoneId: "M001" }), {
    milestoneId: "M001",
    stale: false,
    superseded: false,
  });
  const failed = work("lifecycle/m002");
  assert.equal(failed.attempt_count, 1, "the flush drained the M002 row");
  assert.match(failed.last_error, /disk refuses M002 ROADMAP/);

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

test("a task row renders the task file set, and a slice row renders the slice file set", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  seed("task-lifecycle", "lifecycle/m001/s01/t01");

  assert.equal((await drainProjectionWork(base)).delivered, 1);

  const s01Plan = resolveSliceFile(base, "M001", "S01", "PLAN");
  assert.ok(s01Plan && existsSync(s01Plan), "the plan that lists the task is rendered");
  assert.equal(resolveMilestoneFile(base, "M001", "ROADMAP"), null, "a task row does not render the ROADMAP");
  assert.equal(resolveSliceFile(base, "M001", "S02", "PLAN"), null, "a task row does not render another slice");

  rmSync(s01Plan);
  seed("slice-lifecycle", "lifecycle/m001/s02");
  assert.equal((await drainProjectionWork(base)).delivered, 1);

  const roadmap = resolveMilestoneFile(base, "M001", "ROADMAP");
  const s02Plan = resolveSliceFile(base, "M001", "S02", "PLAN");
  assert.ok(roadmap && existsSync(roadmap), "a slice row renders the ROADMAP that lists the slice");
  assert.ok(s02Plan && existsSync(s02Plan), "a slice row renders its plan");
  assert.equal(existsSync(s01Plan), false, "a slice row does not render another slice");
});

test("each kind that production code enqueues is rendered and settled", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  const requirementsPath = join(base, ".gsd", "REQUIREMENTS.md");
  const statePath = join(base, ".gsd", "STATE.md");
  const queuePath = join(base, ".gsd", "QUEUE.md");
  const rootRoadmapPath = join(base, ".gsd", "ROADMAP.md");
  const queueOrderPath = join(base, ".gsd", "QUEUE-ORDER.json");
  rmSync(requirementsPath);
  // The fixture's mutations already rendered the root files; remove them so the drain must write them.
  for (const path of [statePath, queuePath, rootRoadmapPath, queueOrderPath]) rmSync(path, { force: true });
  const rows: Array<[kind: string, key: string]> = [
    ["state", "project/authority"],
    ["milestone-status", "milestone/m001/active"],
    ["migration-audit", "migration/audit/migration/migration.md"],
    ["queue-order", "queue-order"],
    ["milestone-validation", "validation/m001"],
    ["milestone-subjective-uat", "subjective-uat/m001/q01"],
    ["task-recovery", "task.blocker.accepted/m001/s01/t01"],
    ["task-verification", "verification/m001/s01/t01"],
    ["task-execution", "execution/m001/s01/t01"],
    ["lifecycle-shadow-repair", "lifecycle-shadow-repair/m001/s02"],
    ["markdown", "planning/requirements"],
    ["markdown", "planning/root-artifacts"],
    ["markdown", "knowledge"],
  ];
  insertArtifact({
    path: "PROJECT.md",
    artifact_type: "PROJECT",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: "# Project\n\nStored in the artifacts row.\n",
  });
  for (const [kind, key] of rows) seed(kind, key);

  const drained = await drainProjectionWork(base);

  assert.deepEqual(drained.errors, []);
  assert.equal(drained.delivered, rows.length);
  assert.deepEqual(readProjectionWorkBacklog(), []);
  for (const [, key] of rows) {
    assert.match(String(work(key).rendered_content_hash), /^sha256:[0-9a-f]{64}$/, key);
  }
  assert.match(readFileSync(statePath, "utf-8"), /M001/, "the state kinds render STATE.md");
  assert.match(readFileSync(queuePath, "utf-8"), /M001/, "the state kinds render QUEUE.md");
  assert.match(readFileSync(rootRoadmapPath, "utf-8"), /M001/, "the state kinds render the root ROADMAP.md");
  assert.match(readFileSync(requirementsPath, "utf-8"), /SQLite is authoritative/);
  assert.match(
    readFileSync(join(base, ".gsd", "PROJECT.md"), "utf-8"),
    /Stored in the artifacts row/,
    "the root-artifacts key renders PROJECT.md",
  );
  assert.match(readFileSync(join(base, ".gsd", "KNOWLEDGE.md"), "utf-8"), /## Rules/, "the knowledge key renders KNOWLEDGE.md");
  assert.ok(existsSync(queueOrderPath), "the queue-order kind renders QUEUE-ORDER.json");
  const roadmap = resolveMilestoneFile(base, "M001", "ROADMAP");
  assert.ok(roadmap && existsSync(roadmap), "the milestone kinds render the milestone files");
  const s01Plan = resolveSliceFile(base, "M001", "S01", "PLAN");
  assert.ok(s01Plan && existsSync(s01Plan), "the task kinds render the task files");
});

test("a failed worktree render is kept, retried on the schedule, and shown by doctor and status", async () => {
  fixture = await createDrainedFixture();
  const root = fixture.root;
  const worktree = join(root, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.includes(".gsd-worktrees") && path.endsWith("ROADMAP.md")) throw new Error("worktree refuses ROADMAP");
  });
  seed("slice-lifecycle", "lifecycle/m001/s02");
  const now = new Date();

  const drained = await drainProjectionWork(worktree, { now });

  const row = work("lifecycle/m001/s02");
  assert.equal(row.delivery_state, "rendered", "the project-root delivery settled");
  assert.match(drained.errors.join("\n"), /worktree refuses ROADMAP/);
  const retryTime = new Date(now.getTime() + PROJECTION_LOCK_TRANSIENT_BACKOFF_MS[0]!);
  assert.deepEqual(readProjectionRootReceipts(worktree)[row.projection_work_id], {
    attemptCount: 1,
    lastError: "roadmap M001: worktree refuses ROADMAP",
    nextAttemptAt: retryTime.toISOString(),
  });
  assert.deepEqual(readProjectionWorkBacklog(root), [], "the project root has no backlog");
  assert.deepEqual(
    readProjectionWorkBacklog(worktree).map(({ projectionKey, deliveryState, attemptCount, root: at }) =>
      ({ projectionKey, deliveryState, attemptCount, at: Boolean(at) })),
    [{ projectionKey: "lifecycle/m001/s02", deliveryState: "pending", attemptCount: 1, at: true }],
  );
  const issues: DoctorIssue[] = [];
  await checkProjectionWork(worktree, issues, [], false);
  assert.deepEqual(issues.map(({ severity, code }) => ({ severity, code })), [
    { severity: "warning", code: "projection_work_pending" },
  ]);
  assert.match(issues[0]!.message, /M001 failed 1 time\(s\): .*worktree refuses ROADMAP/);
  assert.match(
    formatTextStatus(await deriveState(worktree), worktree),
    /Projection Work not rendered: 0 pending, 1 retrying, 0 dead-lettered, 0 with no renderer/,
  );

  assert.deepEqual(
    (await drainProjectionWork(worktree, { now: new Date(retryTime.getTime() - 1) })).errors,
    [],
    "not retried before the retry time",
  );
  _setManagedMutationBoundaryForTest(null);
  assert.deepEqual((await drainProjectionWork(worktree, { now: retryTime })).errors, []);
  assert.match(String(readProjectionRootReceipts(worktree)[row.projection_work_id]), /^sha256:[0-9a-f]{64}$/);
  const worktreeRoadmap = resolveMilestoneFile(worktree, "M001", "ROADMAP");
  assert.ok(worktreeRoadmap && existsSync(worktreeRoadmap), "the retry renders the worktree ROADMAP");
  assert.deepEqual(readProjectionWorkBacklog(worktree), []);
});

test("the worktree copy is rendered when the project-root render of the row fails", async () => {
  fixture = await createDrainedFixture();
  const root = fixture.root;
  const worktree = join(root, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (!path.includes(".gsd-worktrees") && path.endsWith("ROADMAP.md")) throw new Error("root refuses ROADMAP");
  });
  seed("slice-lifecycle", "lifecycle/m001/s02");

  await drainProjectionWork(worktree);

  const row = work("lifecycle/m001/s02");
  assert.equal(row.delivery_state, "pending");
  assert.equal(row.attempt_count, 1);
  const worktreeRoadmap = resolveMilestoneFile(worktree, "M001", "ROADMAP");
  assert.ok(worktreeRoadmap && existsSync(worktreeRoadmap), "worktree ROADMAP is rendered");
  assert.match(String(readProjectionRootReceipts(worktree)[row.projection_work_id]), /^sha256:[0-9a-f]{64}$/);
});

test("doctor repair re-renders a milestone whose ROADMAP file is missing and clears the issue", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  await rebuildMarkdownProjectionsFromDb(base);
  const roadmap = resolveMilestoneFile(base, "M001", "ROADMAP");
  assert.ok(roadmap);
  rmSync(roadmap);

  const reported: DoctorIssue[] = [];
  await checkEngineHealth(base, reported, []);
  const missing = reported.filter((issue) => issue.code === "artifact_file_missing");
  assert.equal(missing.length, 1, "doctor reports the missing ROADMAP");
  assert.equal(existsSync(roadmap), false, "doctor without repair does not render");

  const repaired: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, repaired, fixes, { repair: true });

  assert.ok(existsSync(roadmap), "repair renders the ROADMAP again");
  assert.ok(fixes.includes("re-rendered missing projections for M001"));
  assert.deepEqual(repaired.filter((issue) => issue.code === "artifact_file_missing"), []);
  assert.deepEqual(readProjectionWorkBacklog(), [], "the repair work is settled");
});

test("doctor repair requeues a dead-lettered row, and the warning clears when it renders", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.endsWith("ROADMAP.md")) throw new Error("disk refuses ROADMAP");
  });
  seed("slice-lifecycle", "lifecycle/m001/s02");
  await drainUntilDeadLetter(base, "lifecycle/m001/s02");
  const dead: DoctorIssue[] = [];
  await checkProjectionWork(base, dead, [], false);
  assert.deepEqual(dead.map(({ code, fixable }) => ({ code, fixable })), [
    { code: "projection_work_dead_letter", fixable: true },
  ]);

  _setManagedMutationBoundaryForTest(null);
  const repaired: DoctorIssue[] = [];
  await checkProjectionWork(base, repaired, [], true);

  assert.deepEqual(repaired, []);
  const row = work("lifecycle/m001/s02");
  assert.equal(row.delivery_state, "rendered");
  assert.equal(row.attempt_count, 1, "a new head replaced the dead-lettered row");
  assert.doesNotMatch(formatTextStatus(await deriveState(base), base), /Projection Work not rendered/);
});

test("a rebuild requeues a dead-lettered row, and the row is settled as rendered", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.endsWith("ROADMAP.md")) throw new Error("disk refuses ROADMAP");
  });
  seed("slice-lifecycle", "lifecycle/m001/s02");
  await drainUntilDeadLetter(base, "lifecycle/m001/s02");

  _setManagedMutationBoundaryForTest(null);
  const rebuilt = await rebuildMarkdownProjectionsFromDb(base);

  assert.deepEqual(rebuilt.errors, []);
  assert.equal(rebuilt.delivered, 1);
  assert.deepEqual(readProjectionWorkBacklog(), []);
  assert.equal(work("lifecycle/m001/s02").delivery_state, "rendered");
});

test("doctor repair does not requeue or report an unplanned milestone, which has no ROADMAP by design", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  await rebuildMarkdownProjectionsFromDb(base);
  insertMilestone({ id: "M002", title: "", status: "queued" });
  assert.equal(resolveMilestoneFile(base, "M002", "ROADMAP"), null);
  const revision = readDomainOperationFence().revision;

  const issues: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkProjectionWork(base, issues, fixes, true);

  assert.deepEqual(fixes, [], "no re-render is reported");
  assert.deepEqual(issues, []);
  assert.equal(readDomainOperationFence().revision, revision, "no Domain Operation is committed");
  const rebuildRows = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_projection_work WHERE projection_key = 'rebuild/m002'",
  ).get() as { count: number };
  assert.equal(rebuildRows.count, 0, "no work is enqueued for the unplanned milestone");
});

test("doctor repair requeues a dead-lettered milestone rebuild once and renders the missing ROADMAP", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  _setManagedMutationBoundaryForTest((_boundary, path) => {
    if (path.endsWith("ROADMAP.md")) throw new Error("disk refuses ROADMAP");
  });
  const failedFixes: string[] = [];
  await checkProjectionWork(base, [], failedFixes, true);
  assert.deepEqual(failedFixes, [], "a render that failed is not reported as a re-render");
  await drainUntilDeadLetter(base, "rebuild/m001");

  _setManagedMutationBoundaryForTest(null);
  const issues: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkProjectionWork(base, issues, fixes, true);

  assert.deepEqual(issues, []);
  assert.deepEqual(fixes, ["delivered 1 Projection Work row(s)", "re-rendered missing projections for M001"]);
  assert.equal(work("rebuild/m001").delivery_state, "rendered");
  const roadmap = resolveMilestoneFile(base, "M001", "ROADMAP");
  assert.ok(roadmap && existsSync(roadmap));
});

test("doctor repair commits no requeue for a missing artifact that the milestone render does not write", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  await rebuildMarkdownProjectionsFromDb(base);
  insertArtifact({
    path: "milestones/M001/M001-MISSING.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# Missing\n",
  });
  const revision = readDomainOperationFence().revision;

  for (const run of ["first", "second"]) {
    const issues: DoctorIssue[] = [];
    const fixes: string[] = [];
    await checkEngineHealth(base, issues, fixes, { repair: true });

    assert.deepEqual(fixes, [], `${run} repair applies no fix`);
    assert.deepEqual(
      issues.filter((issue) => issue.code === "artifact_file_missing").map(({ file, fixable }) => ({ file, fixable })),
      [{ file: "milestones/M001/M001-MISSING.md", fixable: false }],
      `${run} repair still reports the missing artifact`,
    );
  }

  assert.equal(readDomainOperationFence().revision, revision, "no Domain Operation is committed");
  const requeues = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'projection.requeue'",
  ).get() as { count: number };
  assert.equal(requeues.count, 0);
});

test("a row of a missing or discarded milestone settles once as obsolete and renders no file at any root", async () => {
  fixture = await createDrainedFixture();
  const root = fixture.root;
  const worktree = join(root, ".gsd-worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  insertMilestone({ id: "M003", title: "Discarded", status: "skipped", planning: { vision: "Was planned." } });
  seed("slice-lifecycle", "lifecycle/m002/s01");
  seed("markdown", "planning/m003");

  const drained = await drainProjectionWork(worktree);

  assert.deepEqual(drained.errors, []);
  assert.equal(drained.delivered, 2);
  for (const key of ["lifecycle/m002/s01", "planning/m003"]) {
    const row = work(key);
    assert.equal(row.delivery_state, "rendered", key);
    assert.equal(row.attempt_count, 1, key);
    assert.equal(row.last_error, "", key);
  }
  assert.deepEqual(readProjectionWorkBacklog(worktree), [], "obsolete rows are not counted as failures");
  for (const at of [root, worktree]) {
    assert.equal(resolveMilestoneFile(at, "M003", "ROADMAP"), null, "no file of the discarded milestone is created");
  }
  const issues: DoctorIssue[] = [];
  await checkProjectionWork(worktree, issues, [], false);
  assert.deepEqual(issues, [], "doctor reports nothing for them");
  assert.equal((await drainProjectionWork(worktree, { now: LATER() })).delivered, 0, "settled once");
});

test("doctor repair restores a deleted task SUMMARY, which the milestone render writes", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  _getAdapter()!.prepare(`
    UPDATE tasks SET full_summary_md = '# T01 summary\n'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  await rebuildMarkdownProjectionsFromDb(base);
  const summary = resolveTaskFile(base, "M001", "S01", "T01", "SUMMARY");
  assert.ok(summary && existsSync(summary), "the rebuild renders the task SUMMARY");
  rmSync(summary);

  const reported: DoctorIssue[] = [];
  await checkEngineHealth(base, reported, []);
  assert.deepEqual(
    reported.filter((issue) => issue.code === "artifact_file_missing").map((issue) => issue.unitId),
    ["M001/S01/T01"],
  );

  const repaired: DoctorIssue[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, repaired, fixes, { repair: true });

  assert.ok(existsSync(summary), "repair renders the task SUMMARY again");
  assert.deepEqual(fixes, ["delivered 1 Projection Work row(s)", "re-rendered missing projections for M001"]);
  assert.deepEqual(repaired.filter((issue) => issue.code === "artifact_file_missing"), []);
});

test("a legacy-import drain and a full rebuild create no file of a discarded milestone", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  insertMilestone({ id: "M002", title: "Discarded", status: "skipped", planning: { vision: "Was planned." } });
  seed("markdown", "legacy-import/restore");

  const drained = await drainProjectionWork(base);

  assert.deepEqual(drained.errors, []);
  assert.equal(work("legacy-import/restore").delivery_state, "rendered");
  const roadmap = resolveMilestoneFile(base, "M001", "ROADMAP");
  assert.ok(roadmap && existsSync(roadmap), "the drain renders the other milestone");
  assert.equal(resolveMilestoneFile(base, "M002", "ROADMAP"), null, "the drain creates no M002 file");

  assert.deepEqual((await rebuildMarkdownProjectionsFromDb(base)).errors, []);

  assert.equal(resolveMilestoneFile(base, "M002", "ROADMAP"), null, "the rebuild creates no M002 file");
  assert.equal(
    readdirSync(join(base, ".gsd"), { recursive: true }).some((entry) => /(^|[\\/])02-/.test(String(entry))),
    false,
    "no M002 directory exists",
  );
});

test("doctor does not report a missing artifact file of a discarded milestone", async () => {
  fixture = await createDrainedFixture();
  const base = fixture.root;
  await rebuildMarkdownProjectionsFromDb(base);
  insertMilestone({ id: "M002", title: "Discarded", status: "skipped", planning: { vision: "Was planned." } });
  for (const milestoneId of ["M001", "M002"]) {
    insertArtifact({
      path: `milestones/${milestoneId}/${milestoneId}-MISSING.md`,
      artifact_type: "PLAN",
      milestone_id: milestoneId,
      slice_id: null,
      task_id: null,
      full_content: "# Missing\n",
    });
  }

  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, []);

  assert.deepEqual(
    issues.filter((issue) => issue.code === "artifact_file_missing").map((issue) => issue.unitId),
    ["M001"],
    "the row of the open milestone is reported; the row of the discarded milestone is not",
  );
});
