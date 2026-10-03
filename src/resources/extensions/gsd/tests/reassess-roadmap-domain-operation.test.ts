// Project/App: gsd-pi
// File Purpose: Domain Operation contracts for roadmap reassessment.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
  closeDatabase,
  executeDomainOperation,
  getAssessment,
  getMilestone,
  getSlice,
  getTask,
  insertAssessment,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import type { PlanningInvocation } from "../planning-invocation.ts";
import { writePlanningDirectory } from "../migrate/planning-writer.ts";
import { handlePlanSlice } from "../tools/plan-slice.ts";
import {
  handleReassessRoadmap,
  type ReassessRoadmapParams,
  type ReassessRoadmapResult,
} from "../tools/reassess-roadmap.ts";
import { workflowEventLogPath } from "../workflow-event-ledger.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function fixture(): { base: string; dbPath: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reassess-operation-")));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd", "phases", "01-test-milestone"), { recursive: true });
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Completed", status: "complete", sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Existing future work", status: "pending", sequence: 2 });
  adoptExistingSlice();
  return { base, dbPath };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function count(table: string): number {
  return Number(db().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

function invocation(key: string): PlanningInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "reassess-test",
  };
}

function params(): ReassessRoadmapParams {
  return {
    milestoneId: "M001",
    completedSliceId: "S01",
    verdict: "confirmed",
    assessment: "The completed slice validates the approach.",
    sliceChanges: {
      modified: [{ sliceId: "S02", title: "Refined future work", risk: "high", depends: ["S01"] }],
      added: [
        { sliceId: "S03", title: "Ready follow-up", depends: ["S01"] },
        { sliceId: "S04", title: "Blocked follow-up", depends: ["S02"] },
      ],
      removed: [],
    },
  };
}

function adoptExistingSlice(): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.seed.lifecycle",
    idempotencyKey: "seed/S02",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { sliceId: "S02" },
  }, (context) => {
    adoptLifecycleIfMissing(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S02",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.slice.adopted",
        entityType: "slice",
        entityId: "M001/S02",
        payload: { sliceId: "S02" },
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: "test/s02", projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
}

function adoptDriftedTerminalLifecycle(
  item: "milestone" | "completed-slice",
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.seed.terminal-drift",
    idempotencyKey: `seed/terminal-drift/${item}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { item },
  }, (context) => {
    if (item === "milestone") {
      adoptLifecycleIfMissing(context, {
        itemKind: "milestone",
        milestoneId: "M001",
        lifecycleStatus: "completed",
      });
    } else {
      adoptLifecycleIfMissing(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId: "S01",
        lifecycleStatus: "cancelled",
      });
    }
    return {
      events: [{ eventType: "test.terminal.drift", entityType: item, entityId: item, payload: { item }, destinations: ["projection"] }],
      projections: [{ projectionKey: `test/terminal-drift/${item}`, projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
}

function completeSliceLifecycle(sliceId: string, key: string): void {
  for (const lifecycleStatus of ["ready", "in_progress", "completed"] as const) {
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: `test.slice.${lifecycleStatus}`,
      idempotencyKey: `${key}/${lifecycleStatus}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { sliceId, lifecycleStatus },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice",
        milestoneId: "M001",
        sliceId,
        lifecycleStatus,
      });
      return {
        events: [{ eventType: `test.slice.${lifecycleStatus}`, entityType: "slice", entityId: sliceId, payload: {}, destinations: ["test"] }],
        projections: [{ projectionKey: `${key}/${lifecycleStatus}`, projectionKind: "test", rendererVersion: "1" }],
      };
    });
  }
}

function completeTaskLifecycle(sliceId: string, taskId: string, key: string): void {
  for (const lifecycleStatus of ["in_progress", "completed"] as const) {
    const fence = readDomainOperationFence();
    executeDomainOperation({
      operationType: `test.task.${lifecycleStatus}`,
      idempotencyKey: `${key}/${lifecycleStatus}`,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: "test",
      sourceTransport: "test",
      payload: { sliceId, taskId, lifecycleStatus },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: "M001",
        sliceId,
        taskId,
        lifecycleStatus,
      });
      return {
        events: [{ eventType: `test.task.${lifecycleStatus}`, entityType: "task", entityId: taskId, payload: {}, destinations: ["test"] }],
        projections: [{ projectionKey: `${key}/${lifecycleStatus}`, projectionKind: "test", rendererVersion: "1" }],
      };
    });
  }
}

function lifecycle(sliceId: string): Record<string, unknown> {
  return db().prepare(`
    SELECT lifecycle_status, state_version, last_operation_id, last_project_revision
    FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = ?
  `).get(sliceId) ?? {};
}

function eventLines(base: string): string[] {
  try {
    return readFileSync(workflowEventLogPath(base), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function reassess(
  input: ReassessRoadmapParams,
  base: string,
  envelope: PlanningInvocation,
): Promise<ReassessRoadmapResult | { error: string }> {
  return handleReassessRoadmap(input, base, envelope);
}

test("reassessment preserves its response and adopts added slices with progressive readiness", async () => {
  const { base } = fixture();
  const existingBefore = lifecycle("S02");
  const sliceAssessmentPath = join(base, ".gsd", "phases", "01-test-milestone", "01-01-ASSESSMENT.md");
  const uatAssessment = "---\nuatType: browser-executable\nverdict: PASS\n---\n# Runtime UAT evidence\n";
  writeFileSync(sliceAssessmentPath, uatAssessment, "utf8");

  const result = await reassess(params(), base, invocation("reassess/first"));
  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(result, {
    milestoneId: "M001",
    completedSliceId: "S01",
    assessmentPath: join(base, ".gsd", "phases", "01-test-milestone", "01-ROADMAP-ASSESSMENT.md"),
    roadmapPath: join(base, ".gsd", "phases", "01-test-milestone", "01-ROADMAP.md"),
  });
  assert.deepEqual(lifecycle("S02"), existingBefore, "metadata reassessment must preserve existing lifecycle provenance");
  assert.equal(lifecycle("S03")["lifecycle_status"], "ready");
  assert.equal(lifecycle("S04")["lifecycle_status"], "pending");
  assert.equal(readFileSync(sliceAssessmentPath, "utf8"), uatAssessment, "roadmap reassessment must preserve slice UAT evidence");
  assert.ok(getAssessment(".gsd/phases/01-test-milestone/01-ROADMAP-ASSESSMENT.md"));
  assert.equal(count("workflow_operations"), 2, "seed plus reassessment operations");
  assert.equal(count("workflow_domain_events"), 2);
  assert.equal(eventLines(base).filter((line) => line.includes('"cmd":"reassess-roadmap"')).length, 1);
});

test("reassessment corrects milestone and completed-slice evidence metadata without changing completed structure", async () => {
  const { base } = fixture();
  adoptDriftedTerminalLifecycle("milestone");
  db().prepare("UPDATE milestones SET status = 'complete' WHERE id = 'M001'").run();
  insertTask({
    id: "T01",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Completed evidence task",
    status: "complete",
    planning: {
      description: "Preserved completed work.",
      estimate: "15m",
      files: [],
      verify: "node --test",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "Original task evidence.",
      requiredWorkflowTools: [],
    },
  });
  insertTask({
    id: "T02",
    milestoneId: "M001",
    sliceId: "S01",
    title: "Skipped evidence task",
    status: "skipped",
    planning: {
      description: "Preserved skipped work.",
      estimate: "15m",
      files: [],
      verify: "node --test",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "No task evidence required.",
      requiredWorkflowTools: [],
    },
  });
  const beforeTask = getTask("M001", "S01", "T01");
  const beforeSkippedTask = getTask("M001", "S01", "T02");
  assert.deepEqual(db().prepare(`
    SELECT task_id, lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01'
    ORDER BY task_id
  `).all(), [], "fixture tasks must start without canonical lifecycle authority");
  const beforeMilestoneLifecycle = db().prepare(
    "SELECT lifecycle_status, state_version FROM workflow_item_lifecycles WHERE item_kind = 'milestone' AND milestone_id = 'M001'",
  ).get();
  const validationDbPath = ".gsd/phases/01-test-milestone/01-VALIDATION.md";
  const validationFilePath = join(base, validationDbPath);
  insertAssessment({
    path: validationDbPath,
    milestoneId: "M001",
    status: "passed",
    scope: "milestone-validation",
    fullContent: "PASS against the superseded acceptance contract.",
  });
  writeFileSync(validationFilePath, "# Superseded milestone validation\n", "utf8");

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: [] },
    metadataCorrections: {
      milestone: {
        successCriteria: ["Runtime evidence proves the corrected acceptance policy."],
        verificationContract: "Verify the observed runtime policy.",
        requirementCoverage: "R001 is covered by completed slice S01 evidence.",
        boundaryMapMarkdown: "S01 -> runtime acceptance evidence",
      },
      completedSlices: [{
        sliceId: "S01",
        demo: "The corrected runtime acceptance policy is demonstrable.",
        goal: "Preserve the delivered boundary while correcting its evidence language.",
        successCriteria: "Runtime acceptance evidence is recorded.",
        integrationClosure: "The completed integration boundary remains unchanged.",
        observabilityImpact: "Use the corrected runtime signal.",
      }],
    },
  }, base, invocation("reassess/metadata-correction"));

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.equal(getMilestone("M001")?.status, "complete");
  assert.deepEqual(getMilestone("M001")?.success_criteria, ["Runtime evidence proves the corrected acceptance policy."]);
  assert.equal(getMilestone("M001")?.requirement_coverage, "R001 is covered by completed slice S01 evidence.");
  const completedSlice = getSlice("M001", "S01");
  assert.equal(completedSlice?.status, "complete");
  assert.equal(completedSlice?.demo, "The corrected runtime acceptance policy is demonstrable.");
  assert.equal(completedSlice?.success_criteria, "Runtime acceptance evidence is recorded.");
  assert.deepEqual(getTask("M001", "S01", "T01"), beforeTask, "metadata correction must not mutate completed task rows");
  assert.deepEqual(getTask("M001", "S01", "T02"), beforeSkippedTask, "metadata correction must not mutate skipped task rows");
  assert.deepEqual(db().prepare(`
    SELECT task_id, lifecycle_status, state_version FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S01'
    ORDER BY task_id
  `).all(), [
    { task_id: "T01", lifecycle_status: "completed", state_version: 0 },
    { task_id: "T02", lifecycle_status: "cancelled", state_version: 0 },
  ], "metadata correction must adopt terminal task lifecycles");
  assert.deepEqual(db().prepare(
    "SELECT lifecycle_status, state_version FROM workflow_item_lifecycles WHERE item_kind = 'milestone' AND milestone_id = 'M001'",
  ).get(), beforeMilestoneLifecycle, "metadata correction must preserve completed milestone lifecycle state");
  assert.equal(getAssessment(validationDbPath), null, "acceptance correction must invalidate the superseded validation verdict");
  assert.equal(existsSync(validationFilePath), false, "acceptance correction must remove the superseded validation projection");
  const roadmap = readFileSync((result as ReassessRoadmapResult).roadmapPath, "utf8");
  assert.match(roadmap, /Runtime evidence proves the corrected acceptance policy/);
  assert.match(roadmap, /The corrected runtime acceptance policy is demonstrable/);
  assert.match(roadmap, /S01 -> runtime acceptance evidence/);
});

test("completed-slice metadata correction rejects pending slices without residue", async () => {
  const { base } = fixture();
  const before = {
    operations: count("workflow_operations"),
    slice: getSlice("M001", "S02"),
  };

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: [] },
    metadataCorrections: {
      completedSlices: [{ sliceId: "S02", demo: "Must not be applied." }],
    },
  }, base, invocation("reassess/reject-pending-metadata"));

  assert.ok("error" in result);
  assert.match(result.error, /metadata correction.*S02.*not complete/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    slice: getSlice("M001", "S02"),
  }, before);
});

test("completed-slice metadata correction rejects structural fields", async () => {
  const { base } = fixture();
  const before = getSlice("M001", "S01");

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: [] },
    metadataCorrections: {
      completedSlices: [{
        sliceId: "S01",
        demo: "Evidence-only correction.",
        status: "pending",
      } as never],
    },
  }, base, invocation("reassess/reject-structural-metadata"));

  assert.ok("error" in result);
  assert.match(result.error, /status.*not an allowed correction field/i);
  assert.deepEqual(getSlice("M001", "S01"), before);
  assert.equal(count("workflow_operations"), 1, "only the fixture lifecycle seed should remain");
});

test("exact reassessment replay repairs projections without another mutation or JSONL event", async () => {
  const { base, dbPath } = fixture();
  const envelope = invocation("reassess/replay");
  const first = await reassess(params(), base, envelope);
  assert.ok(!("error" in first));

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.unrelated",
    idempotencyKey: "unrelated/advance",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { unrelated: true },
  }, () => ({
    events: [{ eventType: "test.unrelated", entityType: "project", entityId: "project", payload: {}, destinations: ["projection"] }],
    projections: [{ projectionKey: "test/unrelated", projectionKind: "markdown", rendererVersion: "v1" }],
  }));
  const before = {
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    jsonl: eventLines(base).length,
  };

  closeDatabase();
  assert.equal(openDatabase(dbPath), true);
  const replay = await reassess(params(), base, envelope);
  assert.deepEqual(replay, first);
  assert.deepEqual({
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    jsonl: eventLines(base).length,
  }, before);
});

test("reassessment retry preserves a newer durable assessment projection", async () => {
  const { base } = fixture();
  const originalParams = {
    ...params(),
    sliceChanges: { modified: [], added: [], removed: [] },
  };
  const originalInvocation = invocation("reassess/stale-retry");
  const first = await reassess(originalParams, base, originalInvocation);
  assert.ok(!("error" in first));

  const newerParams = {
    ...originalParams,
    verdict: "adjusted",
    assessment: "A newer reassessment supersedes the original projection.",
  };
  const newer = await reassess(newerParams, base, invocation("reassess/newer"));
  assert.ok(!("error" in newer));
  const newerContent = readFileSync(newer.assessmentPath, "utf8");

  const replay = await reassess(originalParams, base, originalInvocation);
  assert.deepEqual(replay, first);
  assert.equal(
    readFileSync(newer.assessmentPath, "utf8"),
    newerContent,
    "an older exact retry must render the latest durable assessment without changing its creation time",
  );
  assert.match(newerContent, /\*\*Verdict:\*\* adjusted/);
  assert.match(newerContent, /newer reassessment supersedes/);
});

test("same reassessment invocation rejects changed semantics with no residue", async () => {
  const { base } = fixture();
  const envelope = invocation("reassess/conflict");
  const first = await reassess(params(), base, envelope);
  assert.ok(!("error" in first));
  const before = {
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    s03: getSlice("M001", "S03"),
    s04: getSlice("M001", "S04"),
    assessment: getAssessment(".gsd/phases/01-test-milestone/01-ROADMAP-ASSESSMENT.md"),
  };
  const changed = params();
  changed.assessment = "Changed planning semantics under the same invocation.";

  const conflict = await reassess(changed, base, envelope);
  assert.ok("error" in conflict);
  assert.match(conflict.error, /idempotency|request|semantics|conflict/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    events: count("workflow_domain_events"),
    projections: count("workflow_projection_work"),
    s03: getSlice("M001", "S03"),
    s04: getSlice("M001", "S04"),
    assessment: getAssessment(".gsd/phases/01-test-milestone/01-ROADMAP-ASSESSMENT.md"),
  }, before);
});

test("removed slices are cancelled durably, excluded from the roadmap, and require explicit reopen", async () => {
  const { base } = fixture();
  const input: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  };
  const result = await reassess(input, base, invocation("reassess/remove"));
  assert.ok(!("error" in result));

  assert.equal(getSlice("M001", "S02")?.status, "skipped");
  assert.deepEqual(lifecycle("S02"), {
    lifecycle_status: "cancelled",
    state_version: 1,
    last_operation_id: lifecycle("S02")["last_operation_id"],
    last_project_revision: 2,
  });
  assert.doesNotMatch(readFileSync(result.roadmapPath, "utf8"), /\bS02\b/);
  await writePlanningDirectory(base, "flat-phases");
  assert.doesNotMatch(
    readFileSync(join(base, ".planning", "ROADMAP.md"), "utf8"),
    /Existing future work|S02/,
  );

  const before = {
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  };
  const reuse: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [],
      added: [{ sliceId: "S02", title: "Reuse without reopen", depends: ["S01"] }],
      removed: [],
    },
  };
  const rejected = await reassess(reuse, base, invocation("reassess/reuse-cancelled"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /cancelled slice S02|reopen/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  }, before);
});

test("removing a legacy-only pending slice records adoption before cancellation", async () => {
  const { base } = fixture();
  insertSlice({ id: "S05", milestoneId: "M001", title: "Legacy-only future work", status: "pending", sequence: 5 });

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S05"] },
  }, base, invocation("reassess/remove-legacy-only"));
  assert.ok(!("error" in result));
  assert.deepEqual(db().prepare(`
    SELECT lifecycle_status, state_version
    FROM workflow_item_lifecycles
    WHERE item_kind = 'slice' AND milestone_id = 'M001' AND slice_id = 'S05'
  `).get(), { lifecycle_status: "cancelled", state_version: 1 });
});

test("removing a slice cancels runnable descendants and deletes obsolete plan projections", async () => {
  const { base } = fixture();
  const planned = await handlePlanSlice({
    milestoneId: "M001",
    sliceId: "S02",
    goal: "Create descendant planning state before removal.",
    tasks: [{
      taskId: "T01",
      title: "Obsolete task",
      description: "This task becomes unrunnable when its slice is removed.",
      estimate: "15m",
      files: [],
      verify: "node --test",
      inputs: [],
      expectedOutput: [],
    }],
  }, base, invocation("plan-slice/before-removal"));
  assert.ok(!("error" in planned));
  assert.ok(existsSync(planned.planPath));

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  }, base, invocation("reassess/remove-descendants"));
  assert.ok(!("error" in result));

  assert.equal(getTask("M001", "S02", "T01")?.status, "skipped");
  assert.deepEqual(db().prepare(`
    SELECT lifecycle_status FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND milestone_id = 'M001' AND slice_id = 'S02' AND task_id = 'T01'
  `).get(), { lifecycle_status: "cancelled" });
  assert.equal(existsSync(planned.planPath), false);
  assert.equal(
    Number(db().prepare("SELECT COUNT(*) AS count FROM artifacts WHERE milestone_id = 'M001' AND slice_id = 'S02'").get()?.["count"] ?? 0),
    0,
  );
});

test("removing a slice preserves externally edited plan projections", async () => {
  const { base } = fixture();
  const planned = await handlePlanSlice({
    milestoneId: "M001",
    sliceId: "S02",
    goal: "Create a projection that is then externally edited.",
    tasks: [{
      taskId: "T01",
      title: "Externally maintained task",
      description: "The plan content is no longer writer-owned.",
      estimate: "15m",
      files: [],
      verify: "node --test",
      inputs: [],
      expectedOutput: [],
    }],
  }, base, invocation("plan-slice/before-external-edit"));
  assert.ok(!("error" in planned));
  writeFileSync(planned.planPath, "# Manually maintained plan\n", "utf8");

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  }, base, invocation("reassess/preserve-external-plan"));
  assert.ok(!("error" in result));
  assert.equal(readFileSync(planned.planPath, "utf8"), "# Manually maintained plan\n");
});

test("removing a slice rejects completed descendants without residue", async () => {
  const { base } = fixture();
  const planned = await handlePlanSlice({
    milestoneId: "M001",
    sliceId: "S02",
    goal: "Preserve completed descendant history.",
    tasks: [{
      taskId: "T01",
      title: "Completed task",
      description: "This completed work must prevent parent cancellation.",
      estimate: "15m",
      files: [],
      verify: "node --test",
      inputs: [],
      expectedOutput: [],
    }],
  }, base, invocation("plan-slice/completed-descendant"));
  assert.ok(!("error" in planned));
  completeTaskLifecycle("S02", "T01", "test/complete-descendant");
  db().prepare(`
    UPDATE tasks SET status = 'complete'
    WHERE milestone_id = 'M001' AND slice_id = 'S02' AND id = 'T01'
  `).run();

  const before = {
    operations: count("workflow_operations"),
    assessments: count("assessments"),
    slice: getSlice("M001", "S02"),
    task: getTask("M001", "S02", "T01"),
    lifecycles: db().prepare(`
      SELECT item_kind, lifecycle_status, state_version
      FROM workflow_item_lifecycles
      WHERE milestone_id = 'M001' AND slice_id = 'S02'
      ORDER BY item_kind, task_id
    `).all(),
    plan: readFileSync(planned.planPath, "utf8"),
  };

  const result = await reassess({
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  }, base, invocation("reassess/reject-completed-descendant"));

  assert.ok("error" in result);
  assert.match(result.error, /cannot remove.*completed.*task T01|cannot remove completed task T01/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    assessments: count("assessments"),
    slice: getSlice("M001", "S02"),
    task: getTask("M001", "S02", "T01"),
    lifecycles: db().prepare(`
      SELECT item_kind, lifecycle_status, state_version
      FROM workflow_item_lifecycles
      WHERE milestone_id = 'M001' AND slice_id = 'S02'
      ORDER BY item_kind, task_id
    `).all(),
    plan: readFileSync(planned.planPath, "utf8"),
  }, before);
});

test("removal fails before mutation when an unchanged slice would retain a dangling dependency", async () => {
  const { base } = fixture();
  insertSlice({ id: "S05", milestoneId: "M001", title: "Still depends on S02", status: "pending", depends: ["S02"], sequence: 3 });
  const before = {
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
    s05: getSlice("M001", "S05"),
  };
  const input: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: { modified: [], added: [], removed: ["S02"] },
  };

  const rejected = await reassess(input, base, invocation("reassess/dangling"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /S05.*depends.*S02|dangling dependency/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
    s05: getSlice("M001", "S05"),
  }, before);
});

test("modified and added slice identities are validated before roadmap mutation", async () => {
  const { base } = fixture();
  const before = {
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
  };
  const missing: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [{ sliceId: "S99", title: "Missing" }],
      added: [],
      removed: [],
    },
  };
  const missingResult = await reassess(missing, base, invocation("reassess/missing-modified"));
  assert.ok("error" in missingResult);
  assert.match(missingResult.error, /missing slice S99/i);

  const duplicate: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [],
      added: [{ sliceId: "S02", title: "Duplicate" }],
      removed: [],
    },
  };
  const duplicateResult = await reassess(duplicate, base, invocation("reassess/duplicate-added"));
  assert.ok("error" in duplicateResult);
  assert.match(duplicateResult.error, /existing slice S02/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    s02: getSlice("M001", "S02"),
  }, before);
});

test("canonical cancellation vetoes modification even when the legacy slice drifted pending", async () => {
  const { base } = fixture();
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.cancel.slice",
    idempotencyKey: "cancel/S02",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { sliceId: "S02" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S02",
      lifecycleStatus: "cancelled",
    });
    return {
      events: [{ eventType: "test.slice.cancelled", entityType: "slice", entityId: "M001/S02", payload: {}, destinations: ["projection"] }],
      projections: [{ projectionKey: "test/cancel-s02", projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });
  const before = {
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  };
  const input: ReassessRoadmapParams = {
    ...params(),
    sliceChanges: {
      modified: [{ sliceId: "S02", title: "Must not modify" }],
      added: [],
      removed: [],
    },
  };

  const rejected = await reassess(input, base, invocation("reassess/canonical-cancelled"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /cancelled slice S02|reopen/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    lifecycle: lifecycle("S02"),
    slice: getSlice("M001", "S02"),
  }, before);
});

for (const change of ["modify", "remove"] as const) {
  test(`canonical completion vetoes ${change} despite pending legacy drift`, async () => {
    const { base } = fixture();
    completeSliceLifecycle("S02", `test/complete-s02/${change}`);
    const input: ReassessRoadmapParams = {
      ...params(),
      sliceChanges: change === "modify"
        ? { modified: [{ sliceId: "S02", title: "Must not modify" }], added: [], removed: [] }
        : { modified: [], added: [], removed: ["S02"] },
    };

    const rejected = await reassess(input, base, invocation(`reassess/completed-${change}`));
    assert.ok("error" in rejected);
    assert.match(rejected.error, /completed slice S02/i);
  });
}

test("canonical cancellation vetoes a legacy-complete completedSliceId with no residue", async () => {
  const { base } = fixture();
  adoptDriftedTerminalLifecycle("completed-slice");
  const before = {
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  };

  const rejected = await reassess(params(), base, invocation("reassess/cancelled-completed-slice"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /completedSliceId S01.*cancelled|not a valid completed slice/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  }, before);
});

test("canonical terminal milestone vetoes reassessment despite legacy active drift", async () => {
  const { base } = fixture();
  adoptDriftedTerminalLifecycle("milestone");
  const before = {
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  };

  const rejected = await reassess(params(), base, invocation("reassess/terminal-milestone"));
  assert.ok("error" in rejected);
  assert.match(rejected.error, /closed milestone.*canonical status: completed/i);
  assert.deepEqual({
    operations: count("workflow_operations"),
    slices: db().prepare("SELECT id, title, status FROM slices ORDER BY id").all(),
    lifecycles: db().prepare("SELECT lifecycle_id, lifecycle_status, state_version FROM workflow_item_lifecycles ORDER BY lifecycle_id").all(),
  }, before);
});
