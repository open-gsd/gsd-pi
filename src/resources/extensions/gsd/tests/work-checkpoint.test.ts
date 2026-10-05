// Project/App: gsd-pi
// File Purpose: A Work Checkpoint is a database row written by a tool; CONTINUE.md is its render and the resume path is selected from the row.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildExecuteTaskPrompt } from "../auto-prompts.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { markDepthVerified } from "../bootstrap/write-gate.ts";
import { invalidateAllCaches } from "../cache.ts";
import { handleResumeWork } from "../commands-gsd-core.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { showSmartEntry } from "../guided-flow.ts";
import { renderSliceFilesFromDb } from "../markdown-renderer.ts";
import { clearPathCache } from "../paths.ts";
import { drainProjectionWork } from "../projection-worker.ts";
import { executeCheckpointSave, executeSummarySave } from "../tools/workflow-tool-executors.ts";
import { buildActiveResumeSection, buildResumeSection, readWorkCheckpoint, saveWorkCheckpoint } from "../work-checkpoint.ts";
import { saveContextArtifact } from "./helpers/saved-context.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

const SLICE_DIR = join(".gsd", "milestones", "M001", "slices", "S01");
const CONTINUE_FILE = join(SLICE_DIR, "S01-CONTINUE.md");

function rows(sql: string): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(sql).all();
}

/** One active milestone with slice S01 and tasks T01 and T02, each with its lifecycle row. */
function makeProject(t: TestContext): string {
  const base = realpathSync(makeTempRepo("gsd-work-checkpoint-"));
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    cleanup(base);
  });
  mkdirSync(join(base, SLICE_DIR, "tasks"), { recursive: true });
  writeFileSync(join(base, SLICE_DIR, "S01-PLAN.md"), "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: First task**\n- [ ] **T02: Second task**\n");
  writeFileSync(join(base, SLICE_DIR, "tasks", "T01-PLAN.md"), "# T01 Plan\n\nDo the first thing.\n");
  openDatabase(join(base, ".gsd", "gsd.db"));
  invalidateAllCaches();

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.seed",
    idempotencyKey: "test/seed",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "First task", status: "pending" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Second task", status: "pending" });
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready" });
    for (const taskId of ["T01", "T02"]) {
      adoptOrTransitionLifecycle(context, { itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId, lifecycleStatus: "ready" });
    }
    return {
      events: [{ eventType: "test.seeded", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: "test/seed", projectionKind: "test", rendererVersion: "1" }],
    };
  });
  return base;
}

/** Run one lifecycle change in a Domain Operation. */
function transition(key: string, change: (context: Parameters<Parameters<typeof executeDomainOperation>[1]>[0]) => void): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.transition",
    idempotencyKey: `test/${key}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    change(context);
    return {
      events: [{ eventType: "test.transitioned", entityType: "milestone", entityId: "M001", payload: {}, destinations: ["test"] }],
      projections: [{ projectionKey: `test/${key}`, projectionKind: "test", rendererVersion: "1" }],
    };
  });
}

const HANDOFF = {
  milestoneId: "M001",
  sliceId: "S01",
  taskId: "T01",
  kind: "handoff" as const,
  confirmedContext: "Parser rewritten; two fixture tests still fail.",
  unresolved: "Do not revert the Session interface change.",
  nextAction: "Add expiresAt to fixtures/sessions.ts and run the tests again.",
};

test("gsd_checkpoint_save writes one Work Checkpoint row in a Domain Operation and renders CONTINUE.md from it", async (t) => {
  const base = makeProject(t);

  const result = await executeCheckpointSave(HANDOFF, base);

  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const stored = rows(`
    SELECT checkpoint.checkpoint_kind, checkpoint.sequence, checkpoint.confirmed_context,
           checkpoint.suggested_next_action, operation.operation_type, lifecycle.task_id
    FROM workflow_work_checkpoints checkpoint
    JOIN workflow_operations operation ON operation.operation_id = checkpoint.operation_id
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = checkpoint.lifecycle_id
  `);
  assert.deepEqual(stored, [{
    checkpoint_kind: "handoff",
    sequence: 1,
    confirmed_context: HANDOFF.confirmedContext,
    suggested_next_action: HANDOFF.nextAction,
    operation_type: "checkpoint.save",
    task_id: "T01",
  }]);

  const rendered = readFileSync(join(base, CONTINUE_FILE), "utf-8");
  assert.match(rendered, /# Work Checkpoint — M001\/S01\/T01/);
  assert.match(rendered, /Parser rewritten; two fixture tests still fail\./);
  assert.match(rendered, /Add expiresAt to fixtures\/sessions\.ts and run the tests again\./);
});

test("the execute-task prompt takes its Resume State from the checkpoint row, not from a CONTINUE file", async (t) => {
  const base = makeProject(t);

  // A file with no row: the legacy resume authority.
  writeFileSync(
    join(base, CONTINUE_FILE),
    "---\nmilestone: M001\nslice: S01\ntask: T01\nstatus: interrupted\n---\n\n## Completed Work\nFILE-ONLY-STATE\n\n## Next Action\nFollow the file.\n",
  );
  writeFileSync(join(base, SLICE_DIR, "continue.md"), "## Next Action\nLEGACY-FILE-STATE\n");
  clearPathCache();
  const fromFile = await buildExecuteTaskPrompt("M001", "S01", "Slice", "T01", "First task", base);
  assert.match(fromFile, /No Work Checkpoint saved for this task/);
  assert.doesNotMatch(fromFile, /FILE-ONLY-STATE|LEGACY-FILE-STATE/);

  // A row with no file.
  saveWorkCheckpoint(HANDOFF);
  rmSync(join(base, CONTINUE_FILE));
  rmSync(join(base, SLICE_DIR, "continue.md"));
  clearPathCache();
  const fromRow = await buildExecuteTaskPrompt("M001", "S01", "Slice", "T01", "First task", base);
  assert.match(fromRow, /- Completed: Parser rewritten; two fixture tests still fail\./);
  assert.match(fromRow, /- Remaining: Do not revert the Session interface change\./);
  assert.match(fromRow, /- Next action: Add expiresAt to fixtures\/sessions\.ts and run the tests again\./);
});

test("/gsd offers Resume for a task with a checkpoint row, and Execute for a task with only a CONTINUE file", async (t) => {
  const base = makeProject(t);
  const menus: string[][] = [];
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: () => {},
      setStatus: () => {},
      custom: async () => undefined,
      select: async (_title: string, options: string[]) => {
        menus.push(options);
        return undefined;
      },
    },
  } as any;
  const pi = {
    sendMessage: () => {
      throw new Error("the menu must not dispatch a prompt in this test");
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any;

  saveContextArtifact("M001");
  writeFileSync(join(base, CONTINUE_FILE), "## Next Action\nFILE-ONLY-STATE\n");
  writeFileSync(join(base, SLICE_DIR, "continue.md"), "## Next Action\nLEGACY-FILE-STATE\n");
  invalidateAllCaches();
  await showSmartEntry(ctx, pi, base);
  assert.match(menus.at(-1)!.join("\n"), /Execute T01/);
  assert.doesNotMatch(menus.at(-1)!.join("\n"), /Resume T01/);

  saveWorkCheckpoint(HANDOFF);
  rmSync(join(base, CONTINUE_FILE));
  rmSync(join(base, SLICE_DIR, "continue.md"));
  invalidateAllCaches();
  await showSmartEntry(ctx, pi, base);
  assert.match(menus.at(-1)!.join("\n"), /Resume T01/);
});

test("/gsd resume-work takes the handoff from the checkpoint row of the active unit, not from a CONTINUE file", async (t) => {
  const base = makeProject(t);
  const milestoneFile = join(base, ".gsd", "milestones", "M001", "M001-CONTINUE.md");
  const resumePrompt = async (): Promise<string> => {
    const sent: Array<{ content: string }> = [];
    invalidateAllCaches();
    await handleResumeWork("", { cwd: base, ui: { notify() {} } } as any, { sendMessage: (message: any) => sent.push(message) } as any);
    assert.equal(sent.length, 1);
    return sent[0]!.content;
  };

  // Files with no row: the legacy handoff.
  writeFileSync(join(base, CONTINUE_FILE), "## Next Action\nFILE-ONLY-STATE\n");
  writeFileSync(join(base, SLICE_DIR, "continue.md"), "## Next Action\nLEGACY-FILE-STATE\n");
  writeFileSync(milestoneFile, "## Next Action\nMILESTONE-FILE-STATE\n");
  const fromFiles = await resumePrompt();
  assert.match(fromFiles, /## Resume State\n- No Work Checkpoint saved for the active task, slice or milestone\./);
  assert.doesNotMatch(fromFiles, /FILE-ONLY-STATE|LEGACY-FILE-STATE|MILESTONE-FILE-STATE/);
  assert.match(fromFiles, /Do not read a `CONTINUE\.md`, `continue\.md`, or `HANDOFF\.md` file/);

  // Rows with no file. The active unit is task T01: a checkpoint of its slice or
  // milestone is not its resume state.
  rmSync(join(base, CONTINUE_FILE));
  rmSync(join(base, SLICE_DIR, "continue.md"));
  rmSync(milestoneFile);
  saveWorkCheckpoint({ milestoneId: "M001", kind: "handoff", confirmedContext: "Milestone handoff.", nextAction: "Plan the next slice." });
  saveWorkCheckpoint({ milestoneId: "M001", sliceId: "S01", kind: "handoff", confirmedContext: "Paused between tasks.", nextAction: "Start T02." });
  const fromOtherScopes = await resumePrompt();
  assert.match(fromOtherScopes, /## Resume State\n- No Work Checkpoint saved for the active task, slice or milestone\./);
  assert.doesNotMatch(fromOtherScopes, /Milestone handoff\.|Paused between tasks\./);

  saveWorkCheckpoint(HANDOFF);
  const fromTask = await resumePrompt();
  assert.match(fromTask, /Source: Work Checkpoint of M001\/S01\/T01 saved [^\n]+\n- Completed: Parser rewritten; two fixture tests still fail\./);
  assert.match(fromTask, /- Next action: Add expiresAt to fixtures\/sessions\.ts and run the tests again\./);
  assert.equal(existsSync(join(base, CONTINUE_FILE)), false);
});

test("/gsd resume-work does not show the checkpoint of a completed task as the resume state of the next task", async (t) => {
  const base = makeProject(t);
  saveWorkCheckpoint(HANDOFF);
  const t01 = { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01" };
  transition("start-t01", (context) => {
    adoptOrTransitionLifecycle(context, { ...t01, lifecycleStatus: "in_progress" });
  });
  transition("complete-t01", (context) => {
    adoptOrTransitionLifecycle(context, { ...t01, lifecycleStatus: "completed" });
    _getAdapter()!.prepare("UPDATE tasks SET status = 'complete' WHERE id = 'T01'").run();
  });

  const sent: Array<{ content: string }> = [];
  invalidateAllCaches();
  await handleResumeWork("", { cwd: base, ui: { notify() {} } } as any, { sendMessage: (message: any) => sent.push(message) } as any);

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.content, /## Resume State\n- No Work Checkpoint saved for the active task, slice or milestone\./);
  assert.doesNotMatch(sent[0]!.content, /Work Checkpoint of M001\/S01\/T01|Parser rewritten|Add expiresAt/);
  // The row is kept: it is database content.
  assert.equal(readWorkCheckpoint({ milestoneId: "M001", sliceId: "S01", taskId: "T01" })?.kind, "handoff");
});

test("the active resume state is the own checkpoint of the active slice or milestone, and only while that item is open", (t) => {
  makeProject(t);
  saveWorkCheckpoint(HANDOFF);
  saveWorkCheckpoint({ milestoneId: "M001", sliceId: "S01", kind: "handoff", confirmedContext: "Paused between tasks.", nextAction: "Start T02." });
  saveWorkCheckpoint({ milestoneId: "M001", kind: "handoff", confirmedContext: "Queued without discussion.", nextAction: "Discuss M001 from scratch before planning." });

  assert.match(
    buildActiveResumeSection({ milestoneId: "M001", sliceId: "S01" }),
    /Source: Work Checkpoint of M001\/S01 saved [^\n]+\n- Completed: Paused between tasks\.\n- Next action: Start T02\./,
  );
  assert.match(
    buildActiveResumeSection({ milestoneId: "M001" }),
    /Source: Work Checkpoint of M001 saved [^\n]+\n- Completed: Queued without discussion\./,
  );

  transition("cancel-m001", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "cancelled" });
  });
  assert.match(buildActiveResumeSection({ milestoneId: "M001" }), /## Resume State\n- No Work Checkpoint saved for the active task, slice or milestone\./);
  // Another milestone does not get the checkpoint of the closed one.
  assert.match(buildActiveResumeSection({ milestoneId: "M002" }), /## Resume State\n- No Work Checkpoint saved for the active task, slice or milestone\./);
  assert.equal(rows("SELECT 1 FROM workflow_work_checkpoints").length, 3);
});

test("/gsd resume-work does not show a queue-it checkpoint after the CONTEXT of the milestone is saved, and shows a checkpoint saved after that", async (t) => {
  const base = realpathSync(makeTempRepo("gsd-work-checkpoint-readiness-"));
  t.after(() => {
    closeDatabase();
    invalidateAllCaches();
    cleanup(base);
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M003", title: "Queued milestone", status: "active" });
  transition("adopt-m003", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M003", lifecycleStatus: "ready" });
  });
  const resumePrompt = async (): Promise<string> => {
    const sent: Array<{ content: string }> = [];
    invalidateAllCaches();
    await handleResumeWork("", { cwd: base, ui: { notify() {} } } as any, { sendMessage: (message: any) => sent.push(message) } as any);
    assert.equal(sent.length, 1);
    return sent[0]!.content;
  };

  saveWorkCheckpoint({
    milestoneId: "M003",
    kind: "handoff",
    confirmedContext: "M003 is queued without discussion.",
    nextAction: "Discuss M003 from scratch before planning.",
  });
  assert.match(await resumePrompt(), /Source: Work Checkpoint of M003 saved [^\n]+\n- Completed: M003 is queued without discussion\./);

  markDepthVerified("M003", base);
  const saved = await executeSummarySave({ milestone_id: "M003", artifact_type: "CONTEXT", content: "# M003: Queued milestone\n\nDiscussed.\n" }, base);
  assert.notEqual(saved.isError, true, JSON.stringify(saved.content));

  const afterContext = await resumePrompt();
  assert.match(afterContext, /## Resume State\n- No Work Checkpoint saved for the active task, slice or milestone\./);
  assert.doesNotMatch(afterContext, /Discuss M003 from scratch/);
  // The superseded row is kept: it is database content.
  assert.equal(rows("SELECT 1 FROM workflow_work_checkpoints").length, 1);

  saveWorkCheckpoint({ milestoneId: "M003", kind: "handoff", confirmedContext: "M003 is discussed.", nextAction: "Plan M003." });
  assert.match(await resumePrompt(), /Source: Work Checkpoint of M003 saved [^\n]+\n- Completed: M003 is discussed\.\n- Next action: Plan M003\./);
});

test("a checkpoint is the resume state of its own task only, and the newest one is the head", (t) => {
  makeProject(t);

  saveWorkCheckpoint(HANDOFF);
  saveWorkCheckpoint({ ...HANDOFF, kind: "pause", confirmedContext: "Fixtures updated.", nextAction: "Run the full suite." });

  const head = readWorkCheckpoint({ milestoneId: "M001", sliceId: "S01", taskId: "T01" });
  assert.equal(head?.kind, "pause");
  assert.equal(head?.suggestedNextAction, "Run the full suite.");
  assert.deepEqual(
    rows("SELECT sequence FROM workflow_work_checkpoints ORDER BY sequence").map((row) => row["sequence"]),
    [1, 2],
  );
  assert.equal(readWorkCheckpoint({ milestoneId: "M001", sliceId: "S01", taskId: "T02" }), null);
  assert.match(buildResumeSection("M001", "S01", "T02"), /No Work Checkpoint saved for this task/);
});

test("a replay of the same tool call writes no second checkpoint", (t) => {
  makeProject(t);
  const invocation = { idempotencyKey: "pi:gsd_checkpoint_save:call-1", sourceTransport: "pi-tool" as const, actorType: "agent" };

  const first = saveWorkCheckpoint(HANDOFF, invocation);
  const replay = saveWorkCheckpoint(HANDOFF, invocation);

  assert.deepEqual(replay, first);
  assert.equal(rows("SELECT 1 FROM workflow_work_checkpoints").length, 1);
});

test("gsd_checkpoint_save refuses a unit that is not in the database and writes nothing", async (t) => {
  const base = makeProject(t);

  const result = await executeCheckpointSave({ ...HANDOFF, taskId: "T09" }, base);

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /M001\/S01\/T09 has no lifecycle row/);
  assert.equal(rows("SELECT 1 FROM workflow_work_checkpoints").length, 0);
  assert.equal(existsSync(join(base, CONTINUE_FILE)), false);
});

test("the slice render writes CONTINUE.md from the checkpoint row and does not replay an imported CONTINUE artifact over it", async (t) => {
  const base = makeProject(t);
  insertArtifact({
    path: "milestones/M001/slices/S01/S01-CONTINUE.md",
    artifact_type: "CONTINUE",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "IMPORTED-CONTINUE-CONTENT\n",
  });

  // With no checkpoint the imported row is still replayed.
  await renderSliceFilesFromDb(base, "M001", "S01");
  assert.match(readFileSync(join(base, CONTINUE_FILE), "utf-8"), /IMPORTED-CONTINUE-CONTENT/);

  saveWorkCheckpoint(HANDOFF);
  rmSync(join(base, CONTINUE_FILE));
  await renderSliceFilesFromDb(base, "M001", "S01");

  const rendered = readFileSync(join(base, CONTINUE_FILE), "utf-8");
  assert.match(rendered, /Parser rewritten; two fixture tests still fail\./);
  assert.doesNotMatch(rendered, /IMPORTED-CONTINUE-CONTENT/);
  // A render with no database change rewrites no file: the imported row is not replayed first.
  const inode = statSync(join(base, CONTINUE_FILE)).ino;
  await renderSliceFilesFromDb(base, "M001", "S01");
  assert.equal(statSync(join(base, CONTINUE_FILE)).ino, inode);
  // The imported row is database content and is kept.
  assert.match(
    String(rows("SELECT full_content FROM artifacts WHERE artifact_type = 'CONTINUE'")[0]?.["full_content"]),
    /^IMPORTED-CONTINUE-CONTENT\n/,
  );
});

test("the Projection Work of a checkpoint renders the CONTINUE file of a slice and of a milestone", async (t) => {
  const base = makeProject(t);
  saveWorkCheckpoint(HANDOFF);
  saveWorkCheckpoint({
    milestoneId: "M001",
    kind: "handoff",
    confirmedContext: "Queued without discussion at the readiness gate.",
    nextAction: "Discuss M001 from scratch before planning.",
  });

  const drained = await drainProjectionWork(base);

  assert.deepEqual(drained.failedTargets, []);
  assert.match(readFileSync(join(base, CONTINUE_FILE), "utf-8"), /Parser rewritten; two fixture tests still fail\./);
  assert.match(
    readFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTINUE.md"), "utf-8"),
    /# Work Checkpoint — M001\n[\s\S]*Queued without discussion at the readiness gate\./,
  );
});

test("compaction saves a pause checkpoint row for the active task and keeps an earlier checkpoint as the head", async (t) => {
  const base = makeProject(t);
  const handlers = new Map<string, Function>();
  registerHooks({ on(event: string, handler: Function) { handlers.set(event, handler); } } as any, []);
  const compact = handlers.get("session_before_compact")!;
  const event = { preparation: { messagesToSummarize: [{ role: "user", content: "hello" }], turnPrefixMessages: [] } };
  const ctx = { cwd: base, ui: { notify() {}, setWidget() {} } };

  await compact(event, ctx);

  const saved = readWorkCheckpoint({ milestoneId: "M001", sliceId: "S01", taskId: "T01" });
  assert.equal(saved?.kind, "pause");
  assert.match(saved?.confirmedContext ?? "", /Task T01 \(First task\) was in progress when the session was auto-compacted\./);
  assert.match(readFileSync(join(base, CONTINUE_FILE), "utf-8"), /Resume task T01: First task\./);

  await compact(event, ctx);
  assert.equal(rows("SELECT 1 FROM workflow_work_checkpoints").length, 1);
});
