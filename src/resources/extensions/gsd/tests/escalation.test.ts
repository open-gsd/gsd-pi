// GSD Extension — ADR-011 Phase 2 Mid-Execution Escalation tests
// Covers: database question/answer rows, detection, resolution
// (A|B|accept|reject-blocker), DB claim race, carry-forward injection, replay,
// and durability across a database reopen.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getTask,
  findUnappliedEscalationOverride,
  listEscalationArtifacts,
  SCHEMA_VERSION,
  _getAdapter,
} from "../gsd-db.ts";
import {
  buildEscalationArtifact,
  openTaskEscalation,
  readTaskEscalation,
  detectPendingEscalation,
  resolveEscalation,
  claimOverrideForInjection,
  formatLegacyEscalationNotice,
} from "../escalation.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import type { EscalationArtifact, EscalationOption } from "../types.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { handleEscalateCommand } from "../commands/handlers/escalate.ts";
import { withCommandCwd } from "../commands/context.ts";
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";

// ─── Fixture helpers ──────────────────────────────────────────────────────

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-p2-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

/** Give the Task the canonical lifecycle row that an escalation question needs. */
function adoptTaskLifecycle(taskId: string, sliceId: string = "S01"): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.adopt",
    idempotencyKey: `fixture/task/adopt/${sliceId}/${taskId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { sliceId, taskId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId,
      taskId,
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.adopted",
        entityType: "task",
        entityId: `M001/${sliceId}/${taskId}`,
        payload: { taskId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/task/${sliceId}/${taskId}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function seedCompletedTask(base: string, taskId: string, adoptLifecycle: boolean = true): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  insertTask({
    id: taskId, sliceId: "S01", milestoneId: "M001", title: "Task",
    status: "complete",
  });
  if (adoptLifecycle) adoptTaskLifecycle(taskId);
}

let escalationSequence = 0;

/** Open an escalation the way the completion tool does, with a fresh invocation. */
function openEscalation(base: string, artifact: EscalationArtifact): void {
  escalationSequence += 1;
  openTaskEscalation(base, artifact, internalExecutionInvocation(`test:escalation:${escalationSequence}`));
}

function countRows(table: string): number {
  return Number(_getAdapter()!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

/** Every file name under `dir`, at any depth. */
function fileNamesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

const sampleOptions: EscalationOption[] = [
  { id: "A", label: "Separate table", tradeoffs: "More flexible; requires migration." },
  { id: "B", label: "JSON array", tradeoffs: "Simpler; limited to ~1000 entries." },
];

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P2: an escalation is stored as an Open Question with a choice interaction, and no file", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T03");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T03", sliceId: "S01", milestoneId: "M001",
    question: "Where should we store notifications?",
    options: sampleOptions,
    recommendation: "B",
    recommendationRationale: "Single-user display only.",
    continueWithDefault: false,
  }));

  const question = _getAdapter()!.prepare(`
    SELECT question.question_text, question.question_status, lifecycle.task_id,
           interaction.interaction_kind, interaction.presentation_state,
           interaction.recommended_option_id, interaction.interaction_id
    FROM workflow_open_questions question
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = question.lifecycle_id
    JOIN workflow_interactions interaction ON interaction.question_id = question.question_id
  `).all();
  assert.equal(question.length, 1);
  assert.equal(question[0]!["question_text"], "Where should we store notifications?");
  assert.equal(question[0]!["question_status"], "open");
  assert.equal(question[0]!["task_id"], "T03");
  assert.equal(question[0]!["interaction_kind"], "choice");
  assert.equal(question[0]!["presentation_state"], "presented");
  assert.equal(question[0]!["recommended_option_id"], "B");
  const optionIds = _getAdapter()!.prepare(
    "SELECT option_id FROM workflow_interaction_options WHERE interaction_id = :id ORDER BY ordinal",
  ).all({ ":id": question[0]!["interaction_id"] }).map((row) => row["option_id"]);
  assert.deepEqual(optionIds, ["B", "A"], "the recommended option is stored first");

  const roundTrip = readTaskEscalation("M001", "S01", "T03");
  assert.equal(roundTrip?.taskId, "T03");
  assert.equal(roundTrip?.recommendation, "B");
  assert.equal(roundTrip?.recommendationRationale, "Single-user display only.");
  assert.equal(roundTrip?.continueWithDefault, false);
  assert.equal(roundTrip?.respondedAt, undefined);
  assert.deepEqual(roundTrip?.options, [sampleOptions[1], sampleOptions[0]]);

  // The open question is the pause. The task pause flags are not written.
  const row = getTask("M001", "S01", "T03");
  assert.equal(row?.escalation_pending, 0);
  assert.equal(row?.escalation_awaiting_review, 0);
  assert.equal(detectPendingEscalation([row!]), "T03");

  assert.deepEqual(
    fileNamesUnder(join(base, ".gsd")).filter((name) => name.includes("ESCALATION")),
    [],
    "no escalation file is written",
  );
});

test("ADR-011 P2: continueWithDefault=true is stored with the question, not in the task flags", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T04");

  const art = buildEscalationArtifact({
    taskId: "T04", sliceId: "S01", milestoneId: "M001",
    question: "Q",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: true,
  });
  openEscalation(base, art);

  const row = getTask("M001", "S01", "T04");
  assert.equal(row?.escalation_pending, 0);
  assert.equal(row?.escalation_awaiting_review, 0, "the task pause flags are not written");
  assert.equal(readTaskEscalation("M001", "S01", "T04")?.continueWithDefault, true);
  assert.equal(detectPendingEscalation([row!]), "T04", "the open question pauses until the user responds");
});

test("ADR-011 P2: detectPendingEscalation pauses on unresolved awaiting_review escalations", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T01");
  seedCompletedTask(base, "T02");

  // T01: continueWithDefault=true (awaiting_review, not pending)
  openEscalation(base, buildEscalationArtifact({
    taskId: "T01", sliceId: "S01", milestoneId: "M001",
    question: "Q1", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: true,
  }));
  // T02: continueWithDefault=false (pause)
  openEscalation(base, buildEscalationArtifact({
    taskId: "T02", sliceId: "S01", milestoneId: "M001",
    question: "Q2", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const tasks = [getTask("M001", "S01", "T01")!, getTask("M001", "S01", "T02")!];
  const id = detectPendingEscalation(tasks);
  assert.equal(id, "T01", "unresolved awaiting_review escalations must pause before later tasks");
});

test("ADR-011 P2: resolveEscalation(accept) stores the answer + clears flags", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T05");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T05", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const result = resolveEscalation(base, "M001", "S01", "T05", "accept", "looks good");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");

  const row = getTask("M001", "S01", "T05");
  assert.equal(row?.escalation_pending, 0);
  assert.equal(row?.escalation_awaiting_review, 0);

  const art = readTaskEscalation("M001", "S01", "T05");
  assert.ok(art?.respondedAt, "the answer must record respondedAt");
  assert.equal(art?.userChoice, "accept");
  assert.equal(art?.userRationale, "looks good");

  const answer = _getAdapter()!.prepare(`
    SELECT answer.verbatim_response, answer.selected_option_id, answer.answer_disposition,
           question.question_status
    FROM workflow_answers answer
    JOIN workflow_open_questions question ON question.accepted_answer_id = answer.answer_id
  `).all();
  assert.equal(answer.length, 1);
  assert.equal(answer[0]!["verbatim_response"], "accept");
  assert.equal(answer[0]!["selected_option_id"], "B", "accept selects the recommended option");
  assert.equal(answer[0]!["answer_disposition"], "accepted");
  assert.equal(answer[0]!["question_status"], "answered");
});

test("ADR-011 P2: resolveEscalation(reject-blocker) sets blocker_discovered + blocker_source", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T06");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T06", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const result = resolveEscalation(base, "M001", "S01", "T06", "reject-blocker", "none of these work");
  assert.equal(result.status, "rejected-to-blocker");

  const row = getTask("M001", "S01", "T06");
  assert.equal(row?.blocker_discovered, true, "reject-blocker must flip blocker_discovered=1");
  assert.equal(row?.blocker_source, "reject-escalation", "blocker_source must record provenance");
  assert.equal(row?.escalation_pending, 0);
});

test("ADR-011 P2: resolveEscalation(invalid-choice) returns error + leaves state untouched", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T07");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T07", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const result = resolveEscalation(base, "M001", "S01", "T07", "Z", "");
  assert.equal(result.status, "invalid-choice");

  // State must NOT have changed.
  const row = getTask("M001", "S01", "T07");
  assert.equal(detectPendingEscalation([row!]), "T07", "the escalation must still pause after an invalid choice");
  assert.equal(countRows("workflow_answers"), 0, "an invalid choice stores no answer");
});

test("ADR-046: the override claim is one task.escalation.override.claim operation, and the task column does not decide it", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T08");
  const setAppliedAt = (value: string | null) => _getAdapter()!.prepare(
    "UPDATE tasks SET escalation_override_applied_at = :value WHERE id = 'T08'",
  ).run({ ":value": value });

  openEscalation(base, buildEscalationArtifact({
    taskId: "T08", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T08", "A", "pick A");

  // A stale legacy claim marker does not hide the response.
  setAppliedAt("2026-01-01T00:00:00.000Z");
  assert.equal(claimOverrideForInjection("M001", "S01")?.sourceTaskId, "T08", "first claim wins");
  assert.equal(operations("task.escalation.override.claim"), 1);

  // A cleared legacy claim marker does not release the response again.
  setAppliedAt(null);
  assert.equal(findUnappliedEscalationOverride("M001", "S01"), null);
  assert.equal(claimOverrideForInjection("M001", "S01"), null, "second claim must fail — override already applied");
  assert.equal(operations("task.escalation.override.claim"), 1);
  assert.equal(getTask("M001", "S01", "T08")?.escalation_override_applied_at, null, "the claim does not write the task column");
});

test("ADR-046: a claimed override stays claimed across a database reopen", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T08r");
  openEscalation(base, buildEscalationArtifact({
    taskId: "T08r", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T08r", "B", "");
  assert.equal(claimOverrideForInjection("M001", "S01")?.sourceTaskId, "T08r");

  closeDatabase();
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(claimOverrideForInjection("M001", "S01"), null, "the claim event is the record of delivery");
});

test("ADR-011 P2: claimOverrideForInjection returns null when flag ON but no unapplied override", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T09");

  const claimed = claimOverrideForInjection("M001", "S01");
  assert.equal(claimed, null);
});

test("ADR-011 P2: claim does NOT fire on unresolved awaiting_review — resolution is preserved until user responds", (t) => {
  // Regression for peer-review Bug 2: previously findUnappliedEscalationOverride
  // matched `escalation_pending=0` alone, so an awaiting_review task (created
  // by continueWithDefault=true) was silently claimed before the user had
  // a chance to resolve, permanently dropping the override.
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T09a");
  seedCompletedTask(base, "T09b");

  // Write a continueWithDefault=true artifact (awaiting_review=1, no respondedAt).
  openEscalation(base, buildEscalationArtifact({
    taskId: "T09a", sliceId: "S01", milestoneId: "M001",
    question: "Which DB?", options: sampleOptions,
    recommendation: "A", recommendationRationale: "r",
    continueWithDefault: true,
  }));

  // NEXT task's prompt build — must NOT claim the unresolved awaiting_review.
  const premature = claimOverrideForInjection("M001", "S01");
  assert.equal(premature, null, "awaiting_review without respondedAt must not be claimed");

  assert.equal(operations("task.escalation.override.claim"), 0, "nothing must be claimed yet");

  // User now resolves.
  resolveEscalation(base, "M001", "S01", "T09a", "B", "actually B is better");

  // NEXT task's prompt build — NOW the override must be claimed and injected.
  const claimed = claimOverrideForInjection("M001", "S01");
  assert.ok(claimed, "after user resolution, the override must be injectable");
  assert.equal(claimed!.sourceTaskId, "T09a");
  assert.match(claimed!.injectionBlock, /Escalation Override/);
});

test("ADR-011 P2: claimOverrideForInjection returns markdown block once, then null", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T10");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T10", sliceId: "S01", milestoneId: "M001",
    question: "Which storage?",
    options: sampleOptions,
    recommendation: "A",
    recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T10", "A", "pick A");

  const first = claimOverrideForInjection("M001", "S01");
  assert.ok(first, "first claim returns the override");
  assert.match(first!.injectionBlock, /Escalation Override/);
  assert.equal(first!.sourceTaskId, "T10");

  const second = claimOverrideForInjection("M001", "S01");
  assert.equal(second, null, "second call returns null (idempotent)");
});

test("ADR-011 P2: listEscalationArtifacts filters to actionable by default", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T11");
  seedCompletedTask(base, "T12");

  // Pending (actionable)
  openEscalation(base, buildEscalationArtifact({
    taskId: "T11", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  // Resolved (not actionable by default)
  openEscalation(base, buildEscalationArtifact({
    taskId: "T12", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T12", "A", "");

  const actionable = listEscalationArtifacts("M001", false);
  const all = listEscalationArtifacts("M001", true);
  assert.equal(actionable.length, 1, "only T11 is actionable");
  assert.equal(actionable[0]!.id, "T11");
  assert.equal(all.length, 2, "both surface with --all");
});

test("ADR-011 P2: schema v20 fresh DB has all escalation columns on tasks + source on decisions", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const adapter = _getAdapter()!;
  const tasksCols = adapter.prepare("PRAGMA table_info(tasks)").all().map((r) => r["name"] as string);
  for (const col of [
    "blocker_source",
    "escalation_pending",
    "escalation_awaiting_review",
    "escalation_artifact_path",
    "escalation_override_applied_at",
  ]) {
    assert.ok(tasksCols.includes(col), `tasks table must have ${col} column`);
  }

  const decCols = adapter.prepare("PRAGMA table_info(decisions)").all().map((r) => r["name"] as string);
  assert.ok(decCols.includes("source"), "decisions table must have source column");

  const version = adapter.prepare("SELECT MAX(version) as v FROM schema_version").get();
  assert.equal(version?.["v"], SCHEMA_VERSION);
});

test("ADR-011 P2: findUnappliedEscalationOverride returns null when escalation_pending=1 (still pending)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T13");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T13", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // Don't resolve — just query.
  const found = findUnappliedEscalationOverride("M001", "S01");
  assert.equal(found, null, "pending escalation must not surface as unapplied override");
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-011 Phase 3 integration-style tests (concurrent / timeout / recovery /
// latency — adapted from refine-slice phase patterns).
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P3: concurrent escalations queue in arrival order — list returns multiple", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T20");
  seedCompletedTask(base, "T21");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T20", sliceId: "S01", milestoneId: "M001",
    question: "Q1", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  openEscalation(base, buildEscalationArtifact({
    taskId: "T21", sliceId: "S01", milestoneId: "M001",
    question: "Q2", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const pending = listEscalationArtifacts("M001", false);
  assert.equal(pending.length, 2);
  // Both are pause-worthy — state derivation returns the first.
  const first = detectPendingEscalation([getTask("M001", "S01", "T20")!, getTask("M001", "S01", "T21")!]);
  assert.equal(first, "T20", "detection returns first pending in arrival order");
});

test("ADR-011 P3: resolve with no escalation returns not-found without partial state", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T23");

  const result = resolveEscalation(base, "M001", "S01", "T23", "A", "");
  assert.equal(result.status, "not-found");
  const row = getTask("M001", "S01", "T23");
  assert.equal(row?.escalation_pending, 0, "untouched");
});

test("ADR-011 P3: escalation write + detect latency — 20 tasks, one escalation, detection under 100ms", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  for (let i = 1; i <= 20; i++) {
    const tid = `T${String(i).padStart(2, "0")}`;
    insertTask({ id: tid, sliceId: "S01", milestoneId: "M001", title: `Task ${i}`, status: "complete" });
  }
  // Escalation on T15 only.
  adoptTaskLifecycle("T15");
  openEscalation(base, buildEscalationArtifact({
    taskId: "T15", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  const tasks = Array.from({ length: 20 }, (_, i) => getTask("M001", "S01", `T${String(i + 1).padStart(2, "0")}`)!);
  const start = Date.now();
  const found = detectPendingEscalation(tasks);
  const elapsed = Date.now() - start;
  assert.equal(found, "T15");
  assert.ok(elapsed < 100, `detection must complete under 100ms, took ${elapsed}ms`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-011 Phase 3 — Integration: Mid-Execution Escalation
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P3 #20: E2E escalation lifecycle — write → pause → resolve → resume via override injection", (t) => {
  // Exercises the full escalation loop across two tasks in one slice:
  //   1. Executor escalates on T30 with continueWithDefault=false.
  //   2. detectPendingEscalation returns T30 (state.ts:998 is what pauses the loop).
  //   3. User calls resolveEscalation with a specific option choice.
  //   4. detectPendingEscalation returns null — pause condition cleared.
  //   5. The *next* task (T31) in the slice picks up the override block via
  //      claimOverrideForInjection exactly once (idempotent across retries).
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T30");
  seedCompletedTask(base, "T31");

  // Step 1: executor escalates on T30 (pause-scoped).
  openEscalation(base, buildEscalationArtifact({
    taskId: "T30", sliceId: "S01", milestoneId: "M001",
    question: "Storage format for the new metrics table?",
    options: sampleOptions, recommendation: "A", recommendationRationale: "A is simpler",
    continueWithDefault: false,
  }));

  // Step 2: scheduler sees the pause signal.
  let tasks = [getTask("M001", "S01", "T30")!, getTask("M001", "S01", "T31")!];
  assert.equal(
    detectPendingEscalation(tasks),
    "T30",
    "scheduler must pause on T30 before dispatching T31",
  );

  // Claim attempted mid-pause must fail (override not yet resolved).
  assert.equal(
    claimOverrideForInjection("M001", "S01"),
    null,
    "no injection should fire while escalation is still pending",
  );

  // Step 3: user responds with option B + rationale.
  const result = resolveEscalation(base, "M001", "S01", "T30", "B", "B fits better");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");

  // Step 4: pause condition clears.
  tasks = [getTask("M001", "S01", "T30")!, getTask("M001", "S01", "T31")!];
  assert.equal(
    detectPendingEscalation(tasks),
    null,
    "after resolve, scheduler must not re-pause on T30",
  );

  // Step 5: next task (T31) picks up the override exactly once.
  const injected = claimOverrideForInjection("M001", "S01");
  assert.ok(injected, "T31's prompt build must claim the resolved override");
  assert.equal(injected!.sourceTaskId, "T30");
  assert.match(injected!.injectionBlock, /Escalation Override/);
  assert.match(injected!.injectionBlock, /B/, "injection must reflect user's chosen option id");

  const secondClaim = claimOverrideForInjection("M001", "S01");
  assert.equal(secondClaim, null, "override must be consumed exactly once");
});

test("ADR-011 P3 #21: blocker takes priority over escalation when both flags coexist on same task", (t) => {
  // Two invariants together give blocker-priority:
  //   a) state.ts:977-991 checks detectBlockers BEFORE the escalation branch
  //      at state.ts:996-1010, so a blocker flag short-circuits the escalation
  //      pause.
  //   b) resolveEscalation(reject-blocker) atomically clears escalation flags
  //      AND sets blocker_discovered=1 (escalation.ts:227-230), so there is no
  //      post-resolve window where both flags could surface simultaneously.
  // This test pins (b): after reject-blocker, the escalation pause signal is
  // gone and the task is exclusively in blocker-state.
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T40");

  openEscalation(base, buildEscalationArtifact({
    taskId: "T40", sliceId: "S01", milestoneId: "M001",
    question: "Which storage?", options: sampleOptions,
    recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // Pre-condition: escalation is active, blocker is not.
  let row = getTask("M001", "S01", "T40");
  assert.equal(row?.blocker_discovered, false);
  assert.equal(detectPendingEscalation([row!]), "T40");

  // User rejects to blocker — single transition.
  const result = resolveEscalation(
    base, "M001", "S01", "T40", "reject-blocker", "none of these fit the observed constraints",
  );
  assert.equal(result.status, "rejected-to-blocker");

  // Post-condition: blocker is set, escalation flags are cleared.
  row = getTask("M001", "S01", "T40");
  assert.equal(row?.blocker_discovered, true, "blocker_discovered must be set after reject-blocker");
  assert.equal(row?.blocker_source, "reject-escalation", "blocker_source records provenance");
  assert.equal(row?.escalation_pending, 0, "escalation_pending must be cleared");
  assert.equal(row?.escalation_awaiting_review, 0, "escalation_awaiting_review must be cleared");

  // detectPendingEscalation must no longer return T40 — scheduler would
  // otherwise race the blocker branch and pick the wrong phase.
  assert.equal(
    detectPendingEscalation([row!]),
    null,
    "after reject-blocker, escalation must not pause — blocker path owns the task",
  );
});

test("ADR-011 P3 #22: ADR-009 audit envelopes emitted across the escalation lifecycle", (t) => {
  // Verifies that every user-visible escalation event writes a structured
  // audit envelope (eventId, traceId, category, type, ts, payload) to
  // .gsd/audit/events.jsonl. ADR-009 control-plane consumers depend on this
  // shape. Covered event types:
  //   - escalation-manual-attention-created (on write)
  //   - escalation-user-responded            (on resolve with option)
  //   - escalation-rejected-to-blocker       (on reject-blocker)
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T50");
  seedCompletedTask(base, "T51");

  // 1) write → created
  openEscalation(base, buildEscalationArtifact({
    taskId: "T50", sliceId: "S01", milestoneId: "M001",
    question: "Q50", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // 2) resolve(accept) → responded
  resolveEscalation(base, "M001", "S01", "T50", "accept", "sounds right");

  // 3) another write + reject-blocker → rejected
  openEscalation(base, buildEscalationArtifact({
    taskId: "T51", sliceId: "S01", milestoneId: "M001",
    question: "Q51", options: sampleOptions, recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  resolveEscalation(base, "M001", "S01", "T51", "reject-blocker", "blocker path");

  // Read audit log and parse each JSONL envelope.
  const logPath = join(base, ".gsd", "audit", "events.jsonl");
  assert.ok(existsSync(logPath), "audit log must exist at .gsd/audit/events.jsonl");
  const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.length > 0);
  const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const escalationEvents = events.filter((e) => typeof e["type"] === "string" && (e["type"] as string).startsWith("escalation-"));

  // All four lifecycle events must be present.
  const types = escalationEvents.map((e) => e["type"] as string).sort();
  assert.deepEqual(types, [
    "escalation-manual-attention-created",
    "escalation-manual-attention-created",
    "escalation-rejected-to-blocker",
    "escalation-user-responded",
  ]);

  // Every envelope must carry the ADR-009 contract fields.
  for (const env of escalationEvents) {
    assert.equal(typeof env["eventId"], "string", "envelope must include eventId");
    assert.equal(typeof env["traceId"], "string", "envelope must include traceId");
    assert.match(env["traceId"] as string, /^escalation:M001:S01:T5[01]$/, "traceId must be stable and task-scoped");
    assert.equal(env["category"], "gate", "escalation events belong to the gate control plane");
    assert.equal(typeof env["ts"], "string");
    assert.ok(env["payload"] && typeof env["payload"] === "object", "payload must be an object");
    const payload = env["payload"] as Record<string, unknown>;
    assert.equal(payload["milestoneId"], "M001");
    assert.equal(payload["sliceId"], "S01");
    assert.ok(payload["taskId"] === "T50" || payload["taskId"] === "T51");
  }
});

test("ADR-011 P3 #23: concurrent escalations across parallel slices — only the escalating branch pauses", (t) => {
  // In parallel-slice execution each slice has its own active-task view.
  // The scheduler calls detectPendingEscalation(tasks) with *that
  // slice's* tasks only (state.ts:998). So if S01-T60 escalates and S02-T70
  // does not, the S02 branch must remain dispatchable while S01 waits.
  //
  // This test pins: (a) each slice's detectPendingEscalation returns only
  // its own pending tasks, (b) neither branch can see the other's
  // escalation by accident, and (c) resolving one slice's escalation does
  // not clear the other's pause signal.
  const base = makeBase();
  t.after(() => cleanup(base));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice A" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Slice B" });
  insertTask({ id: "T60", sliceId: "S01", milestoneId: "M001", title: "Task A", status: "complete" });
  insertTask({ id: "T70", sliceId: "S02", milestoneId: "M001", title: "Task B", status: "complete" });
  insertTask({ id: "T71", sliceId: "S02", milestoneId: "M001", title: "Task B2", status: "complete" });
  adoptTaskLifecycle("T60", "S01");
  adoptTaskLifecycle("T70", "S02");

  // Both slices escalate at the same time (parallel execution scenario).
  openEscalation(base, buildEscalationArtifact({
    taskId: "T60", sliceId: "S01", milestoneId: "M001",
    question: "S01 ambiguity?", options: sampleOptions,
    recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));
  openEscalation(base, buildEscalationArtifact({
    taskId: "T70", sliceId: "S02", milestoneId: "M001",
    question: "S02 ambiguity?", options: sampleOptions,
    recommendation: "B", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // Per-slice detection: each branch sees only its own pending task.
  const s01Tasks = [getTask("M001", "S01", "T60")!];
  const s02Tasks = [getTask("M001", "S02", "T70")!, getTask("M001", "S02", "T71")!];
  assert.equal(detectPendingEscalation(s01Tasks), "T60");
  assert.equal(detectPendingEscalation(s02Tasks), "T70");

  // Resolve S01's escalation — must NOT clear S02's pause signal.
  resolveEscalation(base, "M001", "S01", "T60", "A", "pick A");
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T60")!]), null);
  assert.equal(
    detectPendingEscalation([getTask("M001", "S02", "T70")!, getTask("M001", "S02", "T71")!]),
    "T70",
    "resolving one slice's escalation must leave the other slice paused",
  );

  // Resolving S02 independently clears the second pause.
  resolveEscalation(base, "M001", "S02", "T70", "B", "pick B");
  assert.equal(detectPendingEscalation([getTask("M001", "S02", "T70")!]), null);
});

test("ADR-011 P3 #24: continueWithDefault requires explicit response before override injection", (t) => {
  // Timeline this test pins:
  //
  //   1. T80 writes continueWithDefault=true → awaiting_review=1.
  //   2. Scheduler detection pauses on T80 instead of treating silence as
  //      consent. Prompt injection still waits until the user responds.
  //   3. After the response, the next prompt build claims the override once.
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T80");
  seedCompletedTask(base, "T83");

  // Phase 1 — T80 escalates with continueWithDefault=true.
  openEscalation(base, buildEscalationArtifact({
    taskId: "T80", sliceId: "S01", milestoneId: "M001",
    question: "Which cache strategy?", options: sampleOptions,
    recommendation: "A", recommendationRationale: "A matches current telemetry",
    continueWithDefault: true,
  }));

  // T80 is awaiting_review (not pending), but scheduler detection still
  // pauses until the user explicitly responds.
  assert.equal(readTaskEscalation("M001", "S01", "T80")?.continueWithDefault, true);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T80")!]), "T80");

  // Prompt injection must still wait for a response.
  assert.equal(
    claimOverrideForInjection("M001", "S01"),
    null,
    "unresolved awaiting_review must not be claimed as a default response",
  );

  // The response window remains open across N tasks — still no override applied.
  assert.equal(
    operations("task.escalation.override.claim"),
    0,
    "nothing is claimed throughout the response window",
  );

  // Phase 2 — user responds with a different option than the recommendation.
  const resolveResult = resolveEscalation(
    base, "M001", "S01", "T80", "B", "after reviewing, B is the call",
  );
  assert.equal(resolveResult.status, "resolved");
  assert.equal(resolveResult.chosenOption?.id, "B");

  // Phase 3 — the very next prompt build (T83) claims the override exactly once.
  const claimed = claimOverrideForInjection("M001", "S01");
  assert.ok(claimed, "T83's prompt build must claim the late-resolved override");
  assert.equal(claimed!.sourceTaskId, "T80");
  assert.match(claimed!.injectionBlock, /Escalation Override/);
  assert.match(
    claimed!.injectionBlock,
    /JSON array|B/,
    "injection must reflect the user's B choice, NOT the original A recommendation",
  );

  // Idempotent — subsequent prompts do not re-inject.
  assert.equal(claimOverrideForInjection("M001", "S01"), null);
});

test("ADR-046: the escalation pause and its resolution survive a database reopen", (t) => {
  // The pause, the question, and the answer live only in database rows, so a
  // new process (a reopened database) still pauses and can still resolve.
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T90");
  openEscalation(base, buildEscalationArtifact({
    taskId: "T90", sliceId: "S01", milestoneId: "M001",
    question: "Which queue?", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  closeDatabase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);

  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T90")!]), "T90", "the pause stays after a restart");
  assert.equal(readTaskEscalation("M001", "S01", "T90")?.question, "Which queue?");

  const result = resolveEscalation(base, "M001", "S01", "T90", "B", "B scales");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T90")!]), null);

  closeDatabase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const resolved = readTaskEscalation("M001", "S01", "T90");
  assert.equal(resolved?.userChoice, "B");
  assert.equal(resolved?.userRationale, "B scales");
  assert.equal(
    resolveEscalation(base, "M001", "S01", "T90", "A", "").status,
    "already-resolved",
    "a second resolution is refused",
  );
  assert.equal(countRows("workflow_answers"), 1);
});

test("ADR-046: a Task without a canonical lifecycle cannot escalate, and nothing is written", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  insertTask({ id: "T91", sliceId: "S01", milestoneId: "M001", title: "T", status: "complete" });

  assert.throws(
    () => openEscalation(base, buildEscalationArtifact({
      taskId: "T91", sliceId: "S01", milestoneId: "M001",
      question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
      continueWithDefault: false,
    })),
    /escalation requires a canonical Task lifecycle for M001\/S01\/T91/,
  );

  const row = getTask("M001", "S01", "T91");
  assert.equal(row?.escalation_pending, 0, "a failed escalation must leave escalation_pending=0");
  assert.equal(row?.escalation_awaiting_review, 0);
  assert.equal(countRows("workflow_open_questions"), 0);
  assert.equal(countRows("workflow_operations"), 0, "the failed operation is rolled back");
  assert.equal(existsSync(join(base, ".gsd", "audit", "events.jsonl")), false, "a failed escalation emits no audit envelope");
});

test("ADR-046: replaying an escalation with the same invocation writes nothing", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T92");
  const artifact = buildEscalationArtifact({
    taskId: "T92", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  });
  const invocation = internalExecutionInvocation("test:escalation:replay");

  openTaskEscalation(base, artifact, invocation);
  openTaskEscalation(base, artifact, invocation);

  assert.equal(countRows("workflow_open_questions"), 1);
  assert.equal(countRows("workflow_interactions"), 1);
  const created = readFileSync(join(base, ".gsd", "audit", "events.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.includes("escalation-manual-attention-created"));
  assert.equal(created.length, 1, "a replay emits no second audit envelope");
});

test("ADR-046: a new escalation on the same Task withdraws the open one", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T93");
  const escalate = (question: string) => openEscalation(base, buildEscalationArtifact({
    taskId: "T93", sliceId: "S01", milestoneId: "M001",
    question, options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  escalate("First question?");
  escalate("Second question?");

  const statuses = _getAdapter()!.prepare(
    "SELECT question_text, question_status FROM workflow_open_questions ORDER BY created_project_revision",
  ).all().map((row) => `${row["question_text"]}:${row["question_status"]}`);
  assert.deepEqual(statuses, ["First question?:withdrawn", "Second question?:open"]);
  assert.equal(readTaskEscalation("M001", "S01", "T93")?.question, "Second question?");

  assert.equal(resolveEscalation(base, "M001", "S01", "T93", "accept", "").status, "resolved");
  assert.equal(readTaskEscalation("M001", "S01", "T93")?.userChoice, "accept");
});

test("ADR-046: the answer to a second escalation on the same Task is injected after the first was claimed", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T95");
  const escalate = (question: string) => openEscalation(base, buildEscalationArtifact({
    taskId: "T95", sliceId: "S01", milestoneId: "M001",
    question, options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  escalate("First question?");
  resolveEscalation(base, "M001", "S01", "T95", "B", "");
  assert.match(claimOverrideForInjection("M001", "S01")!.injectionBlock, /First question\?[\s\S]*\(id: B\)/);

  escalate("Second question?");
  assert.equal(claimOverrideForInjection("M001", "S01"), null, "an open escalation has no override to claim");
  resolveEscalation(base, "M001", "S01", "T95", "A", "");

  const second = claimOverrideForInjection("M001", "S01");
  assert.ok(second, "the second resolution must be injected");
  assert.equal(second.sourceTaskId, "T95");
  assert.match(second.injectionBlock, /Second question\?[\s\S]*\(id: A\)/);
  assert.equal(claimOverrideForInjection("M001", "S01"), null, "the second override is consumed exactly once");
});

test("ADR-046: the question row decides the pause and the pending override, not the task flags", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedCompletedTask(base, "T96");
  const setFlags = (value: 0 | 1) => _getAdapter()!.prepare(
    "UPDATE tasks SET escalation_pending = :value, escalation_awaiting_review = :value WHERE id = 'T96'",
  ).run({ ":value": value });
  openEscalation(base, buildEscalationArtifact({
    taskId: "T96", sliceId: "S01", milestoneId: "M001",
    question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: "r",
    continueWithDefault: false,
  }));

  // The flags are lost while the question is open: the pause stays.
  setFlags(0);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T96")!]), "T96");
  assert.deepEqual(listEscalationArtifacts("M001", false).map((task) => task.id), ["T96"]);
  assert.equal(claimOverrideForInjection("M001", "S01"), null, "an open question must not be claimed");

  // The flags are stale after the answer: no pause, and the override is pending.
  assert.equal(resolveEscalation(base, "M001", "S01", "T96", "B", "").status, "resolved");
  setFlags(1);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T96")!]), null);
  assert.deepEqual(listEscalationArtifacts("M001", false), []);
  assert.equal(claimOverrideForInjection("M001", "S01")?.sourceTaskId, "T96");
});

const LEGACY_PATH = ".gsd/milestones/M001/slices/S01/tasks/T97-ESCALATION.json";

/**
 * Upgrade state: T97 has a T##-ESCALATION.json escalation and no question row.
 * `response` is the user's pre-upgrade resolution; without it the Task is paused.
 */
function seedLegacyEscalation(
  base: string,
  options: {
    writeFile?: boolean;
    response?: { userChoice: string; userRationale: string };
    fileOptions?: EscalationOption[];
    adoptLifecycle?: boolean;
  } = {},
): void {
  seedCompletedTask(base, "T97", options.adoptLifecycle);
  if (options.writeFile !== false) {
    writeFileSync(join(base, LEGACY_PATH), JSON.stringify({
      version: 1, taskId: "T97", sliceId: "S01", milestoneId: "M001",
      question: "Which store?", options: options.fileOptions ?? sampleOptions,
      recommendation: "A", recommendationRationale: "Flexible",
      continueWithDefault: false, createdAt: "2026-01-01T00:00:00.000Z",
      ...(options.response ? { respondedAt: "2026-01-02T00:00:00.000Z", ...options.response } : {}),
    }));
  }
  _getAdapter()!.prepare(
    "UPDATE tasks SET escalation_pending = :pending, escalation_artifact_path = :path WHERE id = 'T97'",
  ).run({ ":pending": options.response ? 0 : 1, ":path": LEGACY_PATH });
}

function operations(type: string): number {
  const row = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = :type",
  ).get({ ":type": type });
  return Number(row?.["count"]);
}

const fourOptions: EscalationOption[] = [
  ...sampleOptions,
  { id: "C", label: "Key-value store", tradeoffs: "Fast; no queries." },
  { id: "D", label: "Flat file", tradeoffs: "No dependency; no concurrency." },
];

/** Run `/gsd escalate <args>` in `base` and return what it told the user. */
async function runEscalateCommand(base: string, args: string): Promise<string> {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nversion: 1\nphases:\n  mid_execution_escalation: true\n---\n");
  const previousCwd = process.cwd();
  process.chdir(base);
  try {
    const notes: string[] = [];
    const ctx = { ui: { notify: (message: string) => notes.push(message) } } as unknown as Parameters<typeof handleEscalateCommand>[1];
    await withCommandCwd(base, () => handleEscalateCommand(args, ctx, {} as Parameters<typeof handleEscalateCommand>[2]));
    return notes.join("\n");
  } finally {
    process.chdir(previousCwd);
  }
}

async function legacyEscalationIssues(
  base: string, repair: boolean, fixesApplied: string[] = [],
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, fixesApplied, { repair });
  return issues.filter((issue) => issue.code === "escalation_legacy_response_unapplied");
}

test("ADR-046: a pre-upgrade escalation pause is resolved through task.escalation.resolve with a validated choice", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base);

  const task = getTask("M001", "S01", "T97")!;
  assert.equal(detectPendingEscalation([task]), "T97", "auto mode must not pass the legacy hard blocker");
  assert.deepEqual(listEscalationArtifacts("M001", false).map((row) => row.id), ["T97"]);

  const invalid = resolveEscalation(base, "M001", "S01", "T97", "Z", "");
  assert.equal(invalid.status, "invalid-choice");
  assert.match(invalid.message, /accept, reject-blocker, A, B/);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T97")!]), "T97", "an invalid choice keeps the pause");
  assert.equal(operations("task.escalation.resolve"), 0);

  const result = resolveEscalation(base, "M001", "S01", "T97", "B", "keep it simple");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "B");
  assert.equal(operations("task.escalation.resolve"), 1);
  assert.equal(countRows("workflow_answers"), 1, "the response is stored as the accepted answer");

  const cleared = getTask("M001", "S01", "T97")!;
  assert.equal(cleared.escalation_pending, 0);
  assert.equal(detectPendingEscalation([cleared]), null);
  const claim = claimOverrideForInjection("M001", "S01");
  assert.equal(claim?.sourceTaskId, "T97");
  assert.match(claim!.injectionBlock, /Which store\?/);
  assert.match(claim!.injectionBlock, /JSON array \(id: B\)/);
  assert.match(claim!.injectionBlock, /keep it simple/);
  assert.equal(resolveEscalation(base, "M001", "S01", "T97", "A", "").status, "already-resolved");
});

test("ADR-046: rejecting a pre-upgrade escalation pause starts the slice replan, also when its file is gone", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base, { writeFile: false });
  // An active slice with a next task, so the derived state has a phase for S01.
  insertTask({ id: "T98", sliceId: "S01", milestoneId: "M001", title: "Next", status: "pending" });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001: Test", "", "## Slices", "", "- [ ] **S01: Slice** `risk:low` `depends:[]`", "  > After this: done.", "",
  ].join("\n"));
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), [
    "# S01: Slice", "", "## Tasks", "", "- [x] **T97: T** `est:10m`", "- [ ] **T98: Next** `est:10m`", "",
  ].join("\n"));
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T98-PLAN.md"), "# T98: Next\n\nDo it.\n");
  invalidateStateCache();
  assert.equal((await deriveStateFromDb(base)).phase, "escalating-task", "the legacy pause holds the slice before the reject");

  const task = getTask("M001", "S01", "T97")!;
  assert.equal(detectPendingEscalation([task]), "T97");
  assert.ok(formatLegacyEscalationNotice(task).includes(LEGACY_PATH), "the notice names the legacy question file");

  const invalid = resolveEscalation(base, "M001", "S01", "T97", "A", "");
  assert.equal(invalid.status, "invalid-choice", "an option id cannot be validated without the file");
  assert.match(invalid.message, /missing or not readable/, "the message names the cause");
  assert.ok(invalid.message.includes(LEGACY_PATH));
  assert.equal(getTask("M001", "S01", "T97")!.escalation_pending, 1);

  const result = resolveEscalation(base, "M001", "S01", "T97", "reject-blocker", "none fit");
  assert.equal(result.status, "rejected-to-blocker");
  assert.equal(operations("task.escalation.resolve"), 1);

  const row = getTask("M001", "S01", "T97")!;
  assert.equal(row.escalation_pending, 0);
  assert.equal(row.blocker_discovered, true);
  assert.equal(row.blocker_source, "reject-escalation");
  assert.equal(detectPendingEscalation([row]), null);
  invalidateStateCache();
  const state = await deriveStateFromDb(base);
  assert.equal(state.phase, "replanning-slice");
  assert.equal(state.activeSlice?.id, "S01");
  assert.equal(resolveEscalation(base, "M001", "S01", "T97", "accept", "").status, "not-found");
});

test("ADR-046: a pre-upgrade escalation response that is not applied is listed, reported by doctor, and converted by doctor --fix", async (t) => {
  const base = makeBase();
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    cleanup(base);
  });
  seedLegacyEscalation(base, { response: { userChoice: "B", userRationale: "keep it simple" } });
  insertTask({ id: "T98", sliceId: "S01", milestoneId: "M001", title: "Next", status: "pending" });

  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T97")!]), null, "a resolved escalation does not pause");
  assert.deepEqual(listEscalationArtifacts("M001", false), []);
  assert.deepEqual(listEscalationArtifacts("M001", true).map((row) => row.id), ["T97"]);

  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nversion: 1\nphases:\n  mid_execution_escalation: true\n---\n");
  process.chdir(base);
  const notes: string[] = [];
  const ctx = { ui: { notify: (message: string) => notes.push(message) } } as unknown as Parameters<typeof handleEscalateCommand>[1];
  await withCommandCwd(base, () => handleEscalateCommand("list --all", ctx, {} as Parameters<typeof handleEscalateCommand>[2]));
  assert.match(notes.join("\n"), /S01\/T97 {2}\[resolved, NOT applied\].*\/gsd doctor --fix/);

  const reported = await legacyEscalationIssues(base, false);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.severity, "warning");
  assert.equal(reported[0]!.unitId, "M001/S01/T97");
  assert.equal(reported[0]!.fixable, true);
  assert.equal(countRows("workflow_open_questions"), 0, "a report without --fix writes nothing");

  const fixesApplied: string[] = [];
  assert.deepEqual(await legacyEscalationIssues(base, true, fixesApplied), []);
  assert.equal(fixesApplied.filter((fix) => fix.includes("M001/S01/T97")).length, 1);
  assert.equal(operations("task.escalation.open"), 1);
  assert.equal(operations("task.escalation.resolve"), 1);
  assert.equal(countRows("workflow_open_questions"), 1);
  assert.equal(countRows("workflow_answers"), 1);
  assert.equal(readTaskEscalation("M001", "S01", "T97")?.userChoice, "B");
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T97")!]), null, "the conversion leaves no pause");

  const claim = claimOverrideForInjection("M001", "S01");
  assert.equal(claim?.sourceTaskId, "T97");
  assert.match(claim!.injectionBlock, /JSON array \(id: B\)/);
  assert.match(claim!.injectionBlock, /keep it simple/);
  assert.deepEqual(await legacyEscalationIssues(base, true), [], "a converted escalation is not reported again");
});

test("ADR-046: a pre-upgrade escalation response in a slice with no next task is not reported or converted", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base, { response: { userChoice: "B", userRationale: "" } });

  assert.deepEqual(listEscalationArtifacts("M001", true), []);
  assert.deepEqual(await legacyEscalationIssues(base, true), []);
  assert.equal(countRows("workflow_open_questions"), 0);
});

test("ADR-046: a pre-upgrade escalation response whose file is gone is reported as not fixable", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base, { writeFile: false, response: { userChoice: "B", userRationale: "" } });
  insertTask({ id: "T98", sliceId: "S01", milestoneId: "M001", title: "Next", status: "pending" });

  const reported = await legacyEscalationIssues(base, true);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.fixable, false);
  assert.equal(countRows("workflow_open_questions"), 0);
});

test("ADR-046: a pre-upgrade escalation with four options is shown, resolved with any option, and carried into the next task", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base, { fileOptions: fourOptions });

  const shown = await runEscalateCommand(base, "show T97");
  for (const option of fourOptions) assert.ok(shown.includes(`[${option.id}] ${option.label}`), shown);
  assert.match(shown, /<A\|B\|C\|D\|accept\|reject-blocker>/);

  const invalid = resolveEscalation(base, "M001", "S01", "T97", "Z", "");
  assert.equal(invalid.status, "invalid-choice");
  assert.match(invalid.message, /accept, reject-blocker, A, B, C, D/);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T97")!]), "T97");

  const result = resolveEscalation(base, "M001", "S01", "T97", "D", "no new dependency");
  assert.equal(result.status, "resolved");
  assert.equal(result.chosenOption?.id, "D");
  assert.equal(operations("task.escalation.resolve"), 1);
  assert.equal(countRows("workflow_interactions"), 0, "four options are not a choice interaction");

  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T97")!]), null);
  const stored = readTaskEscalation("M001", "S01", "T97")!;
  assert.deepEqual(stored.options, fourOptions, "the database holds the full option list");
  assert.equal(stored.userChoice, "D");
  assert.match(await runEscalateCommand(base, "list --all"), /S01\/T97 {2}\[resolved\] {2}Which store\?/);
  assert.equal(resolveEscalation(base, "M001", "S01", "T97", "A", "").status, "already-resolved");

  const claim = claimOverrideForInjection("M001", "S01");
  assert.equal(claim?.sourceTaskId, "T97");
  assert.match(claim!.injectionBlock, /Flat file \(id: D\)/);
  assert.match(claim!.injectionBlock, /no new dependency/);
  assert.equal(claimOverrideForInjection("M001", "S01"), null, "the override is consumed once");
});

test("ADR-046: doctor --fix stores a pre-upgrade four-option escalation response for the next task", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base, { fileOptions: fourOptions, response: { userChoice: "C", userRationale: "speed first" } });
  insertTask({ id: "T98", sliceId: "S01", milestoneId: "M001", title: "Next", status: "pending" });

  const reported = await legacyEscalationIssues(base, false);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.fixable, true);

  assert.deepEqual(await legacyEscalationIssues(base, true), []);
  assert.equal(operations("task.escalation.resolve"), 1);
  assert.equal(detectPendingEscalation([getTask("M001", "S01", "T97")!]), null, "the conversion leaves no pause");
  const claim = claimOverrideForInjection("M001", "S01");
  assert.equal(claim?.sourceTaskId, "T97");
  assert.match(claim!.injectionBlock, /Key-value store \(id: C\)/);
  assert.match(claim!.injectionBlock, /speed first/);
  assert.deepEqual(await legacyEscalationIssues(base, true), [], "a stored response is not reported again");
});

test("ADR-046: a pre-upgrade escalation pause on a Task with no canonical lifecycle resolves with the options show prints", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  seedLegacyEscalation(base, { adoptLifecycle: false });

  const shown = await runEscalateCommand(base, "show T97");
  assert.match(shown, /<A\|B\|accept\|reject-blocker>/);

  const resolved = await runEscalateCommand(base, "resolve T97 B keep it simple");
  assert.match(resolved, /Escalation resolved/);
  assert.equal(operations("task.escalation.resolve"), 1);
  assert.equal(countRows("workflow_open_questions"), 0, "a Task with no lifecycle has no question row");
  assert.equal(getTask("M001", "S01", "T97")!.escalation_pending, 0);
  assert.equal(readTaskEscalation("M001", "S01", "T97")?.userChoice, "B");

  const claim = claimOverrideForInjection("M001", "S01");
  assert.equal(claim?.sourceTaskId, "T97");
  assert.match(claim!.injectionBlock, /JSON array \(id: B\)/);
  assert.match(claim!.injectionBlock, /keep it simple/);
});

test("ADR-046: an escalation is limited to the three options of a choice interaction", () => {
  const fourOptions: EscalationOption[] = [
    ...sampleOptions,
    { id: "C", label: "Blob", tradeoffs: "Opaque." },
    { id: "D", label: "File", tradeoffs: "Not transactional." },
  ];
  assert.throws(
    () => buildEscalationArtifact({
      taskId: "T94", sliceId: "S01", milestoneId: "M001",
      question: "Q", options: fourOptions, recommendation: "A", recommendationRationale: "r",
      continueWithDefault: false,
    }),
    /between 2 and 3 entries \(got 4\)/,
  );
  assert.throws(
    () => buildEscalationArtifact({
      taskId: "T94", sliceId: "S01", milestoneId: "M001",
      question: "Q", options: sampleOptions, recommendation: "A", recommendationRationale: " ",
      continueWithDefault: false,
    }),
    /recommendationRationale must not be blank/,
  );
});
