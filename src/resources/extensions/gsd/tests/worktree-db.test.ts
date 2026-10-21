import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertDecision,
  insertRequirement,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  insertMemoryRow,
  insertVerificationEvidence,
  insertAssessment,
  insertGateRow,
  insertReplanHistory,
  saveGateResult,
  recordMilestoneCommitAttribution,
  getMilestone,
  getSlice,
  getTask,
  getDecisionById,
  getRequirementById,
  getVerificationEvidence,
  updateSliceStatus,
  updateTaskStatus,
  _getAdapter,
  copyWorktreeDb,
  reconcileWorktreeDb,
} from "../gsd-db.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-wt-test-"));
}

function seedMainDb(dbPath: string): void {
  openDatabase(dbPath);
  insertDecision({
    id: "D001",
    when_context: "2025-01-01",
    scope: "M001/S01",
    decision: "Use SQLite",
    choice: "node:sqlite",
    rationale: "Built-in",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "Must store decisions",
    why: "Core feature",
    source: "design",
    primary_owner: "S01",
    supporting_slices: "",
    validation: "test",
    notes: "",
    full_content: "Full requirement text",
    superseded_by: null,
  });
  insertArtifact({
    path: "docs/arch.md",
    artifact_type: "plan",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "Architecture document",
  });
}

function seedTrackedTask(options: {
  milestoneId?: string;
  sliceId?: string;
  taskId?: string;
  sliceTargets?: string[];
  taskTargets?: string[];
} = {}): { milestoneId: string; sliceId: string; taskId: string } {
  const milestoneId = options.milestoneId ?? "M-TRACK";
  const sliceId = options.sliceId ?? "S-TRACK";
  const taskId = options.taskId ?? "T-TRACK";
  insertMilestone({ id: milestoneId, title: "Tracked Milestone", status: "active" });
  insertSlice({
    id: sliceId,
    milestoneId,
    title: "Tracked Slice",
    planning: { targetRepositories: options.sliceTargets ?? [] },
  });
  insertTask({
    id: taskId,
    sliceId,
    milestoneId,
    title: "Tracked Task",
    planning: { targetRepositories: options.taskTargets ?? [] },
  });
  return { milestoneId, sliceId, taskId };
}

function registerCleanup(t: { after: (fn: () => void) => void }, ...dirs: string[]): void {
  t.after(() => {
    closeDatabase();
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
}

// ─── copyWorktreeDb ───────────────────────────────────────────────────────

test("copyWorktreeDb copies DB file and data is queryable", (t) => {
  const srcDir = tempDir();
  const destDir = tempDir();
  registerCleanup(t, srcDir, destDir);

  const srcDb = path.join(srcDir, "gsd.db");
  const destDb = path.join(destDir, "nested", "gsd.db");

  seedMainDb(srcDb);
  closeDatabase();
  assert.ok(fs.statSync(`${srcDb}-wal`).size > 0, "source retains committed WAL frames before copy");

  const result = copyWorktreeDb(srcDb, destDb);
  assert.equal(result, true, "copyWorktreeDb returns true on success");
  assert.ok(fs.existsSync(destDb), "dest DB file exists after copy");

  openDatabase(destDb);
  const d = getDecisionById("D001");
  assert.ok(d !== null, "decision queryable in copied DB");
  assert.equal(d?.choice, "node:sqlite", "decision data preserved in copy");

  const r = getRequirementById("R001");
  assert.ok(r !== null, "requirement queryable in copied DB");
  assert.equal(r?.description, "Must store decisions", "requirement data preserved in copy");
});

test("copyWorktreeDb skips -wal and -shm files", (t) => {
  const srcDir = tempDir();
  const destDir = tempDir();
  registerCleanup(t, srcDir, destDir);

  const srcDb = path.join(srcDir, "gsd.db");
  const destDb = path.join(destDir, "gsd.db");

  seedMainDb(srcDb);
  closeDatabase();

  assert.ok(fs.statSync(srcDb + "-wal").size > 0, "source has a real WAL to snapshot");

  copyWorktreeDb(srcDb, destDb);

  assert.ok(fs.existsSync(destDb), "DB file copied");
  assert.ok(!fs.existsSync(destDb + "-wal"), "WAL file NOT copied");
  assert.ok(!fs.existsSync(destDb + "-shm"), "SHM file NOT copied");
});

test("copyWorktreeDb returns false when source doesn't exist", (t) => {
  const destDir = tempDir();
  registerCleanup(t, destDir);

  const missingSrc = path.join(destDir, "missing", "gsd.db");
  const result = copyWorktreeDb(missingSrc, path.join(destDir, "gsd.db"));
  assert.equal(result, false, "returns false for missing source");
});

test("copyWorktreeDb creates deeply nested dest directories", (t) => {
  const srcDir = tempDir();
  const destDir = tempDir();
  registerCleanup(t, srcDir, destDir);

  const srcDb = path.join(srcDir, "gsd.db");
  const deepDest = path.join(destDir, "a", "b", "c", "gsd.db");

  seedMainDb(srcDb);
  closeDatabase();

  const result = copyWorktreeDb(srcDb, deepDest);
  assert.equal(result, true, "copyWorktreeDb succeeds with nested dest");
  assert.ok(fs.existsSync(deepDest), "DB file created at deeply nested path");
});

// ─── reconcileWorktreeDb ──────────────────────────────────────────────────

test("reconcileWorktreeDb merges new decisions from worktree into main", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  insertDecision({
    id: "D002",
    when_context: "2025-02-01",
    scope: "M001/S02",
    decision: "Use WAL mode",
    choice: "WAL",
    rationale: "Performance",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.decisions > 0, "decisions merged count > 0");
  const d2 = getDecisionById("D002");
  assert.ok(d2 !== null, "D002 from worktree now in main");
  assert.equal(d2?.choice, "WAL", "D002 data correct after merge");
});

test("reconcileWorktreeDb merges new requirements from worktree into main", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertRequirement({
    id: "R002",
    class: "non-functional",
    status: "active",
    description: "Must be fast",
    why: "UX",
    source: "design",
    primary_owner: "S02",
    supporting_slices: "",
    validation: "benchmark",
    notes: "",
    full_content: "Performance requirement",
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.requirements > 0, "requirements merged count > 0");
  const r2 = getRequirementById("R002");
  assert.ok(r2 !== null, "R002 from worktree now in main");
  assert.equal(r2?.description, "Must be fast", "R002 data correct after merge");
});

test("reconcileWorktreeDb merges new artifacts from worktree into main", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertArtifact({
    path: "docs/api.md",
    artifact_type: "reference",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "API documentation",
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.artifacts > 0, "artifacts merged count > 0");
  const adapter = _getAdapter()!;
  const row = adapter.prepare("SELECT * FROM artifacts WHERE path = ?").get("docs/api.md");
  // Statement#get returns undefined (not null) when no row matches, so use
  // loose inequality to catch both — strict `!== null` would silently let a
  // missing artifact row pass this assertion.
  assert.ok(row != null, "artifact from worktree now in main");
  assert.equal((row as any)["artifact_type"], "reference", "artifact data correct after merge");
});

test("reconcileWorktreeDb detects conflicts and applies worktree-wins policy", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  _getAdapter()!.prepare(
    `UPDATE decisions SET choice = 'better-sqlite3' WHERE id = 'D001'`,
  ).run();
  closeDatabase();

  openDatabase(wtDb);
  _getAdapter()!.prepare(
    `UPDATE decisions SET choice = 'sql.js' WHERE id = 'D001'`,
  ).run();
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.conflicts.length > 0, "conflicts detected");
  assert.ok(
    result.conflicts.some((c) => c.includes("D001")),
    "conflict mentions D001",
  );

  const d1 = getDecisionById("D001");
  assert.equal(d1?.choice, "sql.js", "worktree wins on conflict (INSERT OR REPLACE)");
});

test("reconcileWorktreeDb handles missing worktree DB gracefully", (t) => {
  const mainDir = tempDir();
  registerCleanup(t, mainDir);

  const mainDb = path.join(mainDir, "gsd.db");
  seedMainDb(mainDb);

  const missingWt = path.join(mainDir, "missing-worktree.db");
  const result = reconcileWorktreeDb(mainDb, missingWt);
  assert.equal(result.decisions, 0, "no decisions merged for missing worktree DB");
  assert.equal(result.requirements, 0, "no requirements merged for missing worktree DB");
  assert.equal(result.artifacts, 0, "no artifacts merged for missing worktree DB");
  assert.equal(result.conflicts.length, 0, "no conflicts for missing worktree DB");
});

test("reconcileWorktreeDb handles paths containing spaces", (t) => {
  const baseDir = tempDir();
  registerCleanup(t, baseDir);

  const mainDir = path.join(baseDir, "main dir");
  const wtDir = path.join(baseDir, "worktree dir");
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertDecision({
    id: "D003",
    when_context: "2025-03-01",
    scope: "M001/S03",
    decision: "Path spaces test",
    choice: "yes",
    rationale: "Robustness",
    revisable: "no",
    made_by: "agent",
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);
  assert.ok(result.decisions > 0, "reconciliation works with spaces in path");
  const d3 = getDecisionById("D003");
  assert.ok(d3 !== null, "D003 merged from worktree with spaces in path");
});

test("reconcileWorktreeDb leaves main DB usable after DETACH", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(isDbAvailable(), "DB still available after reconciliation");

  insertDecision({
    id: "D099",
    when_context: "2025-12-01",
    scope: "test",
    decision: "Post-reconcile insert",
    choice: "works",
    rationale: "Verify DETACH cleanup",
    revisable: "no",
    made_by: "agent",
    superseded_by: null,
  });

  const d99 = getDecisionById("D099");
  assert.ok(d99 !== null, "can insert and query after reconciliation");
  assert.equal(d99?.choice, "works", "post-reconcile data correct");

  // Verify wt database is detached
  const adapter = _getAdapter()!;
  let wtAccessible = false;
  try {
    adapter.prepare("SELECT count(*) FROM wt.decisions").get();
    wtAccessible = true;
  } catch {
    // Expected — wt should be detached
  }
  assert.ok(!wtAccessible, "wt database is detached after reconciliation");
});

test("reconcileWorktreeDb is a no-op when DBs are identical", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.equal(result.conflicts.length, 0, "no conflicts when DBs are identical");
  assert.ok(isDbAvailable(), "DB usable after no-change reconciliation");
});

test("reconcileWorktreeDb does not downgrade milestone status complete→active (#4372)", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const mainAdapter = _getAdapter()!;
  insertMilestone({ id: "M-COMP", title: "Completed Milestone", status: "complete" });
  mainAdapter.prepare(`UPDATE milestones SET completed_at = '2025-06-01T00:00:00.000Z' WHERE id = 'M-COMP'`).run();
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  _getAdapter()!.prepare(`UPDATE milestones SET status = 'active', completed_at = NULL WHERE id = 'M-COMP'`).run();
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  const m = getMilestone("M-COMP");
  assert.ok(m !== null, "milestone M-COMP still exists after reconcile");
  assert.equal(m!.status, "complete", "complete milestone must not be downgraded to active by stale worktree");
});

test("reconcileWorktreeDb does not downgrade completed slices or tasks", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");
  const completedAt = "2026-06-01T00:00:00.000Z";

  seedMainDb(mainDb);
  const ids = seedTrackedTask({
    milestoneId: "M-COMPLETE-UNITS",
    sliceId: "S-COMPLETE",
    taskId: "T-COMPLETE",
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  updateSliceStatus(ids.milestoneId, ids.sliceId, "complete", completedAt);
  updateTaskStatus(ids.milestoneId, ids.sliceId, ids.taskId, "complete", completedAt);
  closeDatabase();

  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.prepare(
    "UPDATE slices SET status = 'active', completed_at = NULL WHERE milestone_id = :mid AND id = :sid",
  ).run({ ":mid": ids.milestoneId, ":sid": ids.sliceId });
  wtAdapter.prepare(
    "UPDATE tasks SET status = 'pending', completed_at = NULL WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).run({ ":mid": ids.milestoneId, ":sid": ids.sliceId, ":tid": ids.taskId });
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  const slice = getSlice(ids.milestoneId, ids.sliceId);
  assert.equal(slice?.status, "complete", "complete slice must not be downgraded by stale worktree");
  assert.equal(slice?.completed_at, completedAt, "complete slice timestamp must be preserved");

  const task = getTask(ids.milestoneId, ids.sliceId, ids.taskId);
  assert.equal(task?.status, "complete", "complete task must not be downgraded by stale worktree");
  assert.equal(task?.completed_at, completedAt, "complete task timestamp must be preserved");
});

test("reconcileWorktreeDb merges V29 target_repositories from worktree units", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const ids = seedTrackedTask({
    milestoneId: "M-REPOS",
    sliceId: "S-REPOS",
    taskId: "T-REPOS",
    sliceTargets: ["main-slice"],
    taskTargets: ["main-task"],
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.prepare(
    "UPDATE slices SET target_repositories = :targets WHERE milestone_id = :mid AND id = :sid",
  ).run({ ":targets": JSON.stringify(["worktree-slice"]), ":mid": ids.milestoneId, ":sid": ids.sliceId });
  wtAdapter.prepare(
    "UPDATE tasks SET target_repositories = :targets WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).run({ ":targets": JSON.stringify(["worktree-task"]), ":mid": ids.milestoneId, ":sid": ids.sliceId, ":tid": ids.taskId });
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  assert.deepEqual(getSlice(ids.milestoneId, ids.sliceId)?.target_repositories, ["worktree-slice"]);
  assert.deepEqual(getTask(ids.milestoneId, ids.sliceId, ids.taskId)?.target_repositories, ["worktree-task"]);
});

test("reconcileWorktreeDb preserves target_repositories when worktree predates V29", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const ids = seedTrackedTask({
    milestoneId: "M-OLD-REPOS",
    sliceId: "S-OLD-REPOS",
    taskId: "T-OLD-REPOS",
    sliceTargets: ["main-slice"],
    taskTargets: ["main-task"],
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.exec("ALTER TABLE slices DROP COLUMN target_repositories");
  wtAdapter.exec("ALTER TABLE tasks DROP COLUMN target_repositories");
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  assert.deepEqual(getSlice(ids.milestoneId, ids.sliceId)?.target_repositories, ["main-slice"]);
  assert.deepEqual(getTask(ids.milestoneId, ids.sliceId, ids.taskId)?.target_repositories, ["main-task"]);
});

test("reconcileWorktreeDb preserves target_repositories when migrated old worktree has default empty arrays", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const ids = seedTrackedTask({
    milestoneId: "M-MIGRATED-REPOS",
    sliceId: "S-MIGRATED-REPOS",
    taskId: "T-MIGRATED-REPOS",
    sliceTargets: ["main-slice"],
    taskTargets: ["main-task"],
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.prepare(
    "UPDATE slices SET target_repositories = '[]' WHERE milestone_id = :mid AND id = :sid",
  ).run({ ":mid": ids.milestoneId, ":sid": ids.sliceId });
  wtAdapter.prepare(
    "UPDATE tasks SET target_repositories = '[]' WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).run({ ":mid": ids.milestoneId, ":sid": ids.sliceId, ":tid": ids.taskId });
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  assert.deepEqual(getSlice(ids.milestoneId, ids.sliceId)?.target_repositories, ["main-slice"]);
  assert.deepEqual(getTask(ids.milestoneId, ids.sliceId, ids.taskId)?.target_repositories, ["main-task"]);
});

test("reconcileWorktreeDb preserves memory metadata when worktree predates memory columns", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");
  const memoryId = "mem-reconcile";
  const createdAt = "2026-06-01T00:00:00.000Z";
  const updatedAt = "2026-06-02T00:00:00.000Z";
  const lastHitAt = "2026-06-03T00:00:00.000Z";

  seedMainDb(mainDb);
  insertMemoryRow({
    id: memoryId,
    category: "architecture",
    content: "Main memory content",
    confidence: 0.7,
    sourceUnitType: "task",
    sourceUnitId: "T001",
    createdAt,
    updatedAt,
    scope: "workspace",
    tags: ["db", "memory"],
    structuredFields: { sourceDecisionId: "D-MEM" },
  });
  _getAdapter()!.prepare(
    "UPDATE memories SET last_hit_at = :last_hit_at, hit_count = 3 WHERE id = :id",
  ).run({ ":last_hit_at": lastHitAt, ":id": memoryId });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.exec("DROP INDEX IF EXISTS idx_memories_scope");
  wtAdapter.exec("ALTER TABLE memories DROP COLUMN scope");
  wtAdapter.exec("ALTER TABLE memories DROP COLUMN tags");
  wtAdapter.exec("ALTER TABLE memories DROP COLUMN structured_fields");
  wtAdapter.exec("ALTER TABLE memories DROP COLUMN last_hit_at");
  wtAdapter.prepare(
    "UPDATE memories SET content = :content, confidence = :confidence, updated_at = :updated_at WHERE id = :id",
  ).run({
    ":content": "Worktree memory content",
    ":confidence": 0.9,
    ":updated_at": "2026-06-04T00:00:00.000Z",
    ":id": memoryId,
  });
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  const row = _getAdapter()!.prepare("SELECT * FROM memories WHERE id = :id").get({ ":id": memoryId }) as Record<string, unknown>;
  assert.equal(row["content"], "Worktree memory content");
  assert.equal(row["confidence"], 0.9);
  assert.equal(row["scope"], "workspace");
  assert.equal(row["tags"], JSON.stringify(["db", "memory"]));
  assert.equal(row["structured_fields"], JSON.stringify({ sourceDecisionId: "D-MEM" }));
  assert.equal(row["last_hit_at"], lastHitAt);
});

test("reconcileWorktreeDb continues when an older worktree is missing an optional table", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertDecision({
    id: "D-MISSING-TABLE",
    when_context: "2026-06-01",
    scope: "M001",
    decision: "Merge despite old optional tables",
    choice: "guard table reads",
    rationale: "Old worktrees may lack newer tables",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  _getAdapter()!.exec("DROP TABLE memories");
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.equal(result.conflicts.length, 0);
  assert.equal(getDecisionById("D-MISSING-TABLE")?.choice, "guard table reads");
});

test("reconcileWorktreeDb preserves decision seq when replaying worktree decisions", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  insertDecision({
    id: "D002",
    when_context: "2026-06-02",
    scope: "M001",
    decision: "Second decision",
    choice: "keep order",
    rationale: "Reconcile must not reset seq",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  const before = _getAdapter()!.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);
  const after = _getAdapter()!.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();

  assert.deepEqual(after, before);
});

test("reconcileWorktreeDb recomputes artifact hash when worktree predates content_hash", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");
  const artifactPath = "docs/hash.md";

  seedMainDb(mainDb);
  insertArtifact({
    path: artifactPath,
    artifact_type: "plan",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "old content",
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.exec("ALTER TABLE artifacts DROP COLUMN content_hash");
  wtAdapter.prepare("UPDATE artifacts SET full_content = :content WHERE path = :path").run({
    ":content": "new content",
    ":path": artifactPath,
  });
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);
  const row = _getAdapter()!.prepare("SELECT full_content, content_hash FROM artifacts WHERE path = :path").get({
    ":path": artifactPath,
  }) as Record<string, unknown>;

  assert.equal(row["full_content"], "new content");
  assert.equal(row["content_hash"], createHash("sha256").update("new content").digest("hex"));
});

test("reconcileWorktreeDb merges correctness rows from worktree", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const ids = seedTrackedTask({
    milestoneId: "M-CORRECTNESS",
    sliceId: "S-CORRECTNESS",
    taskId: "T-CORRECTNESS",
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  insertSlice({ id: "S-BASE", milestoneId: ids.milestoneId, title: "Base Slice" });
  insertSlice({ id: "S-DEPENDENT", milestoneId: ids.milestoneId, title: "Dependent Slice", depends: ["S-BASE"] });
  wtAdapter.prepare(
    "INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id) VALUES (?, ?, ?)",
  ).run(ids.milestoneId, "S-DEPENDENT", "S-BASE");
  insertAssessment({
    path: ".gsd/milestones/M-CORRECTNESS/M-CORRECTNESS-VALIDATION.md",
    milestoneId: ids.milestoneId,
    status: "pass",
    scope: "validate-milestone",
    fullContent: "# Validation\n\nPASS",
  });
  insertReplanHistory({
    milestoneId: ids.milestoneId,
    sliceId: ids.sliceId,
    taskId: ids.taskId,
    summary: "Replanned in worktree",
    previousArtifactPath: "old.md",
    replacementArtifactPath: "new.md",
  });
  insertGateRow({ milestoneId: ids.milestoneId, sliceId: ids.sliceId, gateId: "Q3", scope: "slice" });
  saveGateResult({
    milestoneId: ids.milestoneId,
    sliceId: ids.sliceId,
    gateId: "Q3",
    verdict: "pass",
    rationale: "Worktree gate passed",
    findings: "No findings",
  });
  recordMilestoneCommitAttribution({
    commitSha: "abc123",
    milestoneId: ids.milestoneId,
    sliceId: ids.sliceId,
    taskId: ids.taskId,
    source: "recorded",
    confidence: 0.95,
    files: ["src/example.ts"],
    createdAt: "2026-06-05T00:00:00.000Z",
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);
  const adapter = _getAdapter()!;

  assert.ok(result.assessments > 0, "assessment rows should merge");
  assert.ok(result.replan_history > 0, "replan history rows should merge");
  assert.ok(result.quality_gates > 0, "quality gate rows should merge");
  assert.ok(result.slice_dependencies > 0, "slice dependency rows should merge");
  assert.ok(result.gate_runs > 0, "gate run rows should merge");
  assert.ok(result.milestone_commit_attributions > 0, "commit attribution rows should merge");
  assert.equal(
    (adapter.prepare("SELECT count(*) AS n FROM assessments WHERE milestone_id = :mid").get({ ":mid": ids.milestoneId }) as Record<string, unknown>)["n"],
    1,
  );
  assert.equal(
    (adapter.prepare("SELECT count(*) AS n FROM replan_history WHERE summary = 'Replanned in worktree'").get() as Record<string, unknown>)["n"],
    1,
  );
  assert.equal(
    (adapter.prepare("SELECT verdict FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND gate_id = 'Q3'").get({
      ":mid": ids.milestoneId,
      ":sid": ids.sliceId,
    }) as Record<string, unknown>)["verdict"],
    "pass",
  );
  assert.equal(
    (adapter.prepare("SELECT depends_on_slice_id FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = 'S-DEPENDENT'").get({
      ":mid": ids.milestoneId,
    }) as Record<string, unknown>)["depends_on_slice_id"],
    "S-BASE",
  );
  assert.equal(
    (adapter.prepare("SELECT count(*) AS n FROM gate_runs WHERE milestone_id = :mid").get({ ":mid": ids.milestoneId }) as Record<string, unknown>)["n"],
    1,
  );
  assert.equal(
    (adapter.prepare("SELECT commit_sha FROM milestone_commit_attributions WHERE milestone_id = :mid").get({
      ":mid": ids.milestoneId,
    }) as Record<string, unknown>)["commit_sha"],
    "abc123",
  );
});

test("reconcileWorktreeDb appends new verification evidence without duplicating copied rows", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const ids = seedTrackedTask({
    milestoneId: "M-EVIDENCE",
    sliceId: "S-EVIDENCE",
    taskId: "T-EVIDENCE",
  });
  insertVerificationEvidence({
    taskId: ids.taskId,
    sliceId: ids.sliceId,
    milestoneId: ids.milestoneId,
    command: "pnpm test",
    exitCode: 0,
    verdict: "pass",
    durationMs: 100,
  });
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  insertVerificationEvidence({
    taskId: ids.taskId,
    sliceId: ids.sliceId,
    milestoneId: ids.milestoneId,
    command: "pnpm lint",
    exitCode: 0,
    verdict: "pass",
    durationMs: 50,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);
  const evidence = getVerificationEvidence(ids.milestoneId, ids.sliceId, ids.taskId);

  assert.equal(result.verification_evidence, 1, "only the new evidence row should be appended");
  assert.equal(evidence.length, 2, "copied evidence row should not duplicate during reconcile");
  assert.deepEqual(evidence.map((row) => row.command).sort(), ["pnpm lint", "pnpm test"]);
});
