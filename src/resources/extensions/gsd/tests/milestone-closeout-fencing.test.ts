// gsd-pi — Behavioral coverage for adopted milestone closeout fencing.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _resetMergeDbReadyDepsForTests,
  _setMergeDbReadyDepsForTests,
  assertMilestoneDbReadyForMerge,
} from "../auto-worktree-merge-db-ready.js";
import { executeDomainOperation } from "../db/domain-operation.js";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.js";
import {
  _getAdapter,
  closeDatabase,
  getArtifact,
  getMilestone,
  insertMilestone,
  isDbAvailable,
  openDatabase,
  updateMilestoneStatus,
  upsertMilestonePlanning,
} from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { executeSummarySave } from "../tools/workflow-tool-executors.ts";

type CanonicalMilestoneStatus = "ready" | "completed";

function makeBase(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function cleanup(base: string): void {
  _resetMergeDbReadyDepsForTests();
  if (isDbAvailable()) closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function adoptMilestone(
  lifecycleStatus: CanonicalMilestoneStatus,
  legacyStatus = lifecycleStatus === "completed" ? "complete" : "active",
  milestoneId = "M001",
): void {
  insertMilestone({ id: milestoneId, title: "Milestone", status: legacyStatus });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: `test.milestone.${lifecycleStatus}`,
    idempotencyKey: `test:milestone-closeout-fencing:${milestoneId.toLowerCase()}:${lifecycleStatus}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId, lifecycleStatus },
  }, (context) => {
    const lifecycle = adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId,
      lifecycleStatus,
      adoptedFromStatus: lifecycleStatus,
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: milestoneId,
        payload: { lifecycleId: lifecycle.lifecycleId, lifecycleStatus },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function lifecycleStatus(milestoneId = "M001"): string | undefined {
  return _getAdapter()!.prepare(`
    SELECT lifecycle_status
    FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = :milestone_id
  `).get({ ":milestone_id": milestoneId })?.["lifecycle_status"] as string | undefined;
}

function operationCount(): number {
  return Number(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()?.["count"] ?? 0);
}

function useProjectDbForMerge(base: string): void {
  const dbPath = join(base, ".gsd", "gsd.db");
  _setMergeDbReadyDepsForTests({
    isDbAvailable: () => true,
    resolveGsdPathContract: () => ({
      projectDb: dbPath,
      worktreeGsd: join(base, ".gsd-worktrees", "M001", ".gsd"),
    } as never),
    getWorkflowDatabasePath: () => dbPath,
    shouldReconcileWorktreeDb: () => false,
    proveMilestoneCloseout: () => ({ ok: true }),
  });
}

function checkMilestoneReadyForMerge(base: string): void {
  assertMilestoneDbReadyForMerge({
    milestoneId: "M001",
    projectRoot: base,
    worktreeCwd: join(base, ".gsd-worktrees", "M001"),
  });
}

test("merge cleanup cannot close an adopted ready milestone", () => {
  const base = makeBase("gsd-adopted-merge-ready-");
  try {
    adoptMilestone("ready");
    useProjectDbForMerge(base);
    const operationsBefore = operationCount();

    assert.throws(
      () => checkMilestoneReadyForMerge(base),
      /canonical|lifecycle|adopted|completed/i,
    );
    assert.equal(getMilestone("M001")?.status, "active");
    assert.equal(lifecycleStatus(), "ready");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("merge cleanup accepts an adopted completed milestone without creating authority", () => {
  const base = makeBase("gsd-adopted-merge-completed-");
  try {
    adoptMilestone("completed");
    useProjectDbForMerge(base);
    const operationsBefore = operationCount();

    assert.doesNotThrow(() => checkMilestoneReadyForMerge(base));
    assert.equal(getMilestone("M001")?.status, "complete");
    assert.equal(lifecycleStatus(), "completed");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("merge cleanup rejects a completed canonical lifecycle with an open legacy row", () => {
  const base = makeBase("gsd-adopted-merge-mismatch-");
  try {
    adoptMilestone("completed", "active");
    useProjectDbForMerge(base);
    const operationsBefore = operationCount();

    assert.throws(
      () => checkMilestoneReadyForMerge(base),
      /mismatch|canonical|legacy|status/i,
    );
    assert.equal(getMilestone("M001")?.status, "active");
    assert.equal(lifecycleStatus(), "completed");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("generic status updates cannot close an adopted ready milestone", () => {
  const base = makeBase("gsd-adopted-generic-status-");
  try {
    adoptMilestone("ready");
    const operationsBefore = operationCount();

    assert.throws(
      () => updateMilestoneStatus("M001", "complete", "2026-07-14T12:00:00.000Z"),
      /canonical|lifecycle|adopted|completed/i,
    );
    assert.equal(getMilestone("M001")?.status, "active");
    assert.equal(lifecycleStatus(), "ready");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("generic legacy writers preserve canonical completion across terminal aliases", () => {
  const base = makeBase("gsd-adopted-terminal-alias-");
  try {
    adoptMilestone("completed", "done");
    const fenceBefore = readDomainOperationFence();
    const operationsBefore = operationCount();

    assert.throws(
      () => updateMilestoneStatus("M001", "skipped", "2026-07-14T12:00:00.000Z"),
      /canonical|lifecycle|adopted|completed/i,
    );
    assert.equal(getMilestone("M001")?.status, "done");
    assert.equal(getMilestone("M001")?.completed_at, null);
    assert.equal(lifecycleStatus(), "completed");
    assert.deepEqual(readDomainOperationFence(), fenceBefore);
    assert.equal(operationCount(), operationsBefore);

    assert.doesNotThrow(() => updateMilestoneStatus(
      "M001",
      "closed",
      "2026-07-14T12:00:00.000Z",
      true,
    ));
    assert.equal(getMilestone("M001")?.status, "closed");
    assert.equal(getMilestone("M001")?.completed_at, "2026-07-14T12:00:00.000Z");
    assert.equal(lifecycleStatus(), "completed");
    assert.deepEqual(readDomainOperationFence(), fenceBefore);
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("generic legacy writers preserve adopted ready semantics across nonterminal aliases", () => {
  const base = makeBase("gsd-adopted-nonterminal-alias-");
  try {
    adoptMilestone("ready", "queued");
    const fenceBefore = readDomainOperationFence();
    const operationsBefore = operationCount();

    for (const invalidStatus of ["parked", "blocked"]) {
      assert.throws(
        () => updateMilestoneStatus("M001", invalidStatus),
        /canonical|lifecycle|adopted|ready/i,
      );
      assert.equal(getMilestone("M001")?.status, "queued");
    }

    assert.doesNotThrow(() => updateMilestoneStatus("M001", "planned"));
    assert.equal(getMilestone("M001")?.status, "planned");
    assert.doesNotThrow(() => updateMilestoneStatus("M001", "active"));
    assert.equal(getMilestone("M001")?.status, "active");
    assert.equal(lifecycleStatus(), "ready");
    assert.deepEqual(readDomainOperationFence(), fenceBefore);
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("generic legacy writers cannot silently repair an adopted status mismatch", () => {
  const base = makeBase("gsd-adopted-status-mismatch-");
  try {
    adoptMilestone("completed");
    _getAdapter()!.prepare(
      "UPDATE milestones SET status = 'skipped' WHERE id = 'M001'",
    ).run();
    const fenceBefore = readDomainOperationFence();

    assert.throws(
      () => updateMilestoneStatus("M001", "complete", "2026-07-14T12:00:00.000Z"),
      /mismatch|canonical|legacy|adopted/i,
    );
    assert.equal(getMilestone("M001")?.status, "skipped");
    assert.equal(lifecycleStatus(), "completed");
    assert.deepEqual(readDomainOperationFence(), fenceBefore);
  } finally {
    cleanup(base);
  }
});

test("PROJECT milestone registration cannot close an adopted ready milestone", async () => {
  const base = makeBase("gsd-adopted-project-save-");
  try {
    const milestoneId = "M001-b1nole";
    adoptMilestone("ready", "active", milestoneId);
    const operationsBefore = operationCount();

    const result = await executeSummarySave({
      artifact_type: "PROJECT",
      content: "# Project\n\n## Milestone Sequence\n- [x] M001: Milestone - Complete\n",
    }, base);

    assert.notEqual(result.isError, true);
    assert.equal(result.details.milestoneSequenceSelfHealed, true);
    assert.equal(getMilestone(milestoneId)?.status, "active");
    assert.equal(lifecycleStatus(milestoneId), "ready");
    assert.equal(operationCount(), operationsBefore);
    const project = getArtifact("PROJECT.md");
    assert.ok(project);
    assert.match(project.full_content, /- \[ \] M001-b1nole:/);
    assert.doesNotMatch(project.full_content, /- \[x\] M001(?:-b1nole)?:/i);
  } finally {
    cleanup(base);
  }
});

test("PROJECT milestone registration repairs an unchecked adopted completed milestone", async () => {
  const base = makeBase("gsd-adopted-project-completed-");
  try {
    adoptMilestone("completed");
    const operationsBefore = operationCount();

    const result = await executeSummarySave({
      artifact_type: "PROJECT",
      content: "# Project\n\n## Milestone Sequence\n- [ ] M001: Milestone - Planned\n",
    }, base);

    assert.notEqual(result.isError, true);
    assert.equal(result.details.milestoneSequenceSelfHealed, true);
    assert.equal(getMilestone("M001")?.status, "complete");
    assert.equal(lifecycleStatus(), "completed");
    assert.equal(operationCount(), operationsBefore);
    const project = getArtifact("PROJECT.md");
    assert.ok(project);
    assert.match(project.full_content, /- \[x\] M001:/i);
    assert.doesNotMatch(project.full_content, /- \[ \] M001:/);
  } finally {
    cleanup(base);
  }
});

test("PROJECT save rejects an adopted canonical and legacy status mismatch before persistence", async () => {
  const base = makeBase("gsd-adopted-project-mismatch-");
  try {
    adoptMilestone("ready");
    const priorContent = "# Project\n\n## Milestone Sequence\n- [ ] M001: Milestone - Planned\n";
    const initial = await executeSummarySave({
      artifact_type: "PROJECT",
      content: priorContent,
    }, base);
    assert.notEqual(initial.isError, true);

    _getAdapter()!.prepare(
      "UPDATE milestones SET status = 'complete' WHERE id = 'M001'",
    ).run();
    const fenceBefore = readDomainOperationFence();
    const operationsBefore = operationCount();

    const result = await executeSummarySave({
      artifact_type: "PROJECT",
      content: "# Project\n\n## Milestone Sequence\n- [x] M001: Milestone - Complete\n",
    }, base);

    assert.equal(result.isError, true);
    assert.equal(getMilestone("M001")?.status, "complete");
    assert.equal(lifecycleStatus(), "ready");
    assert.deepEqual(readDomainOperationFence(), fenceBefore);
    assert.equal(operationCount(), operationsBefore);
    const storedProject = getArtifact("PROJECT.md");
    assert.ok(storedProject);
    assert.equal(storedProject.full_content, priorContent);
    assert.equal(existsSync(join(base, ".gsd", "PROJECT.md")), true);
  } finally {
    cleanup(base);
  }
});

test("PROJECT repair renders completed legacy aliases as checked", async () => {
  const base = makeBase("gsd-adopted-project-alias-");
  try {
    adoptMilestone("completed", "done");
    const fenceBefore = readDomainOperationFence();
    const operationsBefore = operationCount();

    const result = await executeSummarySave({
      artifact_type: "PROJECT",
      content: "# Project\n\n## Milestone Sequence\n- [ ] M001: Milestone - Planned\n",
    }, base);

    assert.notEqual(result.isError, true);
    assert.equal(result.details.milestoneSequenceSelfHealed, true);
    assert.equal(getMilestone("M001")?.status, "done");
    assert.equal(lifecycleStatus(), "completed");
    assert.deepEqual(readDomainOperationFence(), fenceBefore);
    assert.equal(operationCount(), operationsBefore);
    const storedProject = getArtifact("PROJECT.md");
    assert.ok(storedProject);
    assert.match(storedProject.full_content, /- \[x\] M001:/i);
    assert.doesNotMatch(storedProject.full_content, /- \[ \] M001:/);
    assert.equal(existsSync(join(base, ".gsd", "PROJECT.md")), true);
  } finally {
    cleanup(base);
  }
});

test("full Markdown import cannot close an adopted ready milestone", () => {
  const base = makeBase("gsd-adopted-full-import-");
  try {
    adoptMilestone("ready");
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(
      join(milestoneDir, "M001-ROADMAP.md"),
      "# M001: Milestone\n\n**Vision:** Ship it\n\n## Slices\n- [x] **S01: Done Slice** `risk:low` `depends:[]`\n",
      "utf-8",
    );
    const operationsBefore = operationCount();

    try {
      migrateHierarchyToDb(base);
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /canonical|lifecycle|adopted|completed/i);
    }

    assert.equal(getMilestone("M001")?.status, "active");
    assert.equal(lifecycleStatus(), "ready");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("closed-to-closed timestamp repair remains allowed", () => {
  const base = makeBase("gsd-adopted-closed-repair-");
  try {
    adoptMilestone("completed");
    const operationsBefore = operationCount();

    assert.doesNotThrow(() => updateMilestoneStatus(
      "M001",
      "complete",
      "2026-07-14T12:00:00.000Z",
      true,
    ));
    assert.equal(getMilestone("M001")?.status, "complete");
    assert.equal(getMilestone("M001")?.completed_at, "2026-07-14T12:00:00.000Z");
    assert.equal(lifecycleStatus(), "completed");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});

test("planning-only milestone metadata updates remain allowed", () => {
  const base = makeBase("gsd-adopted-planning-update-");
  try {
    adoptMilestone("ready");
    const operationsBefore = operationCount();

    assert.doesNotThrow(() => upsertMilestonePlanning("M001", {
      title: "Refined Milestone",
      vision: "A clearer outcome",
    }));
    assert.equal(getMilestone("M001")?.title, "Refined Milestone");
    assert.equal(getMilestone("M001")?.vision, "A clearer outcome");
    assert.equal(getMilestone("M001")?.status, "active");
    assert.equal(lifecycleStatus(), "ready");
    assert.equal(operationCount(), operationsBefore);
  } finally {
    cleanup(base);
  }
});
