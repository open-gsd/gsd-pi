// Project/App: gsd-pi
// File Purpose: Executable contract for the additive v33 conversation foundation.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  _getAdapter,
  _setMigrationFaultForTest,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";

const require = createRequire(import.meta.url);
const tempDirs = new Set<string>();
const V34_TABLES = [
  "workflow_remediation_links", "workflow_human_acceptances", "workflow_verification_evidence",
  "workflow_technical_verdicts", "workflow_acceptance_criteria", "workflow_recovery_actions",
  "workflow_recovery_budgets", "workflow_failure_observations",
] as const;
const V34_INDEXES = [
  "idx_workflow_attempt_scope_v34", "idx_workflow_result_scope_v34",
  "idx_workflow_blocker_scope_v34",
] as const;

interface RawDb {
  readonly isOpen: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

function openRawDatabase(path: string): RawDb {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-conversation-foundation-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function tableExists(db: RawDb, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function indexExists(db: RawDb, index: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
  );
}

function assertV34Absent(db: RawDb): void {
  for (const table of V34_TABLES) {
    assert.equal(tableExists(db, table), false, `${table} should be absent`);
  }
  for (const index of V34_INDEXES) {
    assert.equal(indexExists(db, index), false, `${index} should be absent`);
  }
}

function maxSchemaVersion(db: RawDb): number {
  return Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version);
}

function projectId(db: RawDb): string {
  return String(db.prepare("SELECT project_id FROM project_authority WHERE singleton = 1").get()?.project_id);
}

function seedLegacyRows(db: RawDb): void {
  db.exec(`
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES
      ('M-DISC', 'Product discovery', 'active', '2026-07-12T00:00:00.000Z'),
      ('M-OTHER', 'Independent delivery', 'active', '2026-07-12T00:00:00.000Z');
    INSERT OR IGNORE INTO decisions (
      id, when_context, scope, decision, choice, rationale, revisable,
      made_by, source, superseded_by
    ) VALUES (
      'D-LEGACY', 'legacy', 'project', 'Preserve me', 'yes',
      'Legacy decision remains byte-for-byte unchanged', 'yes',
      'user', 'discussion', NULL
    );
  `);
}

function insertOperation(db: RawDb, revision: number, actorType = "agent", actorId = "test"): string {
  const id = `op-${revision}`;
  db.prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision,
      expected_authority_epoch, resulting_authority_epoch,
      actor_type, actor_id, source_transport, request_hash, created_at
    ) VALUES (?, ?, 'test', ?, ?, ?, 0, 0, ?, ?, 'test', ?, ?)
  `).run(
    id,
    projectId(db),
    `key-${id}`,
    revision - 1,
    revision,
    actorType,
    actorId,
    `hash-${id}`,
    `2026-07-12T00:00:${String(revision).padStart(2, "0")}.000Z`,
  );
  return id;
}

function insertOperations(db: RawDb, count: number): void {
  for (let revision = 1; revision <= count; revision += 1) insertOperation(db, revision);
}

function insertMilestoneLifecycle(
  db: RawDb,
  lifecycleId: string,
  milestoneId: string,
  operationId: string,
  revision: number,
): void {
  db.prepare(`
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
      created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, 'milestone', ?, 'in_progress', '', '', ?, ?, 0)
  `).run(lifecycleId, projectId(db), milestoneId, operationId, revision);
}

function insertQuestion(
  db: RawDb,
  questionId: string,
  lifecycleId: string,
  operationId: string,
  revision: number,
  text = "Which route best fits the product outcome?",
): void {
  db.prepare(`
    INSERT INTO workflow_open_questions (
      question_id, project_id, lifecycle_id, question_text, question_status,
      state_version, created_at, updated_at,
      created_operation_id, created_project_revision, created_authority_epoch,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (?, ?, ?, ?, 'open', 0, '', '', ?, ?, 0, ?, ?, 0)
  `).run(
    questionId,
    projectId(db),
    lifecycleId,
    text,
    operationId,
    revision,
    operationId,
    revision,
  );
}

interface InteractionInput {
  interactionId: string;
  questionId: string;
  sequence: number;
  kind?: string;
  operationId: string;
  revision: number;
  recommendedOptionId?: string | null;
  recommendedOrdinal?: number;
}

function insertPresentedChoice(db: RawDb, input: InteractionInput): void {
  const recommendedOptionId = input.recommendedOptionId === undefined ? "option-recommended" : input.recommendedOptionId;
  const recommendedOrdinal = input.recommendedOrdinal ?? 1;
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO workflow_interactions (
        interaction_id, project_id, question_id, sequence, interaction_kind,
        presentation_state, focused_prompt, requires_answer, option_count,
        recommended_option_id, recommendation_text, recommendation_rationale,
        recommendation_evidence, recommendation_confidence,
        recommendation_uncertainty, revisit_condition, presented_at,
        operation_id, project_revision, authority_epoch
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, 1, 2, ?, ?, ?, ?, 0.85, ?, ?, '', ?, ?, 0)
    `).run(
      input.interactionId,
      projectId(db),
      input.questionId,
      input.sequence,
      input.kind ?? "choice",
      "Which direction should we take?",
      recommendedOptionId,
      "Use the database-first route.",
      "It prevents state drift and keeps recovery deterministic.",
      "ADR-046 and current code mapping",
      "A required external integration could change this.",
      "Revisit when the integration constraint is known.",
      input.operationId,
      input.revision,
    );
    for (const option of [
      { id: "option-recommended", ordinal: recommendedOrdinal, label: "Database first", description: "Persist canonical facts before presentation." },
      { id: "option-alternate", ordinal: recommendedOrdinal === 1 ? 2 : 1, label: "Files first", description: "Keep readable files authoritative." },
    ]) {
      db.prepare(`
        INSERT INTO workflow_interaction_options (
          interaction_id, option_id, project_id, ordinal, label, description,
          operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        input.interactionId,
        option.id,
        projectId(db),
        option.ordinal,
        option.label,
        option.description,
        input.operationId,
        input.revision,
      );
    }
    db.prepare(
      "UPDATE workflow_interactions SET presentation_state = 'presented' WHERE interaction_id = ?",
    ).run(input.interactionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertPresentedRecap(db: RawDb, input: InteractionInput): void {
  db.prepare(`
    INSERT INTO workflow_interactions (
      interaction_id, project_id, question_id, sequence, interaction_kind,
      presentation_state, focused_prompt, requires_answer, option_count,
      recommendation_text, recommendation_rationale,
      recommendation_evidence, recommendation_confidence,
      recommendation_uncertainty, revisit_condition, presented_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, 'recap', 'prepared', ?, 0, 0, '', '', '', NULL, '', '', '', ?, ?, 0)
  `).run(
    input.interactionId,
    projectId(db),
    input.questionId,
    input.sequence,
    "Here is what I understand so far.",
    input.operationId,
    input.revision,
  );
  db.prepare(
    "UPDATE workflow_interactions SET presentation_state = 'presented' WHERE interaction_id = ?",
  ).run(input.interactionId);
}

function insertAcceptedAnswer(db: RawDb, input: {
  answerId: string;
  interactionId: string;
  questionId: string;
  operationId: string;
  revision: number;
  responseKind?: string;
  verbatim?: string;
  normalized?: string;
  selectedOptionId?: string | null;
}): void {
  db.prepare(`
    INSERT INTO workflow_answers (
      answer_id, project_id, question_id, interaction_id, response_kind,
      verbatim_response, selected_option_id, normalized_interpretation,
      interpretation_confidence, answer_disposition, observed_project_revision,
      created_at, operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.9, 'accepted', ?, '', ?, ?, 0)
  `).run(
    input.answerId,
    projectId(db),
    input.questionId,
    input.interactionId,
    input.responseKind ?? "answer",
    input.verbatim ?? "Use the database-first route.",
    input.selectedOptionId === undefined ? "option-recommended" : input.selectedOptionId,
    input.normalized ?? "select_database_first",
    input.revision - 1,
    input.operationId,
    input.revision,
  );
}

function insertDecision(db: RawDb, input: {
  decisionId: string;
  questionId: string;
  answerId: string;
  operationId: string;
  revision: number;
  supersedesDecisionId?: string | null;
  text?: string;
}): void {
  db.prepare(`
    INSERT INTO workflow_conversation_decisions (
      decision_id, project_id, question_id, answer_id, decision_text,
      supersedes_decision_id, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 0)
  `).run(
    input.decisionId,
    projectId(db),
    input.questionId,
    input.answerId,
    input.text ?? "Use the database-first route.",
    input.supersedesDecisionId ?? null,
    input.operationId,
    input.revision,
  );
}

function openFreshFixture(): { dbPath: string; db: RawDb } {
  const dbPath = createDatabasePath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  seedLegacyRows(db);
  return { dbPath, db };
}

function rewindToV32(dbPath: string): void {
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const db = openRawDatabase(dbPath);
  try {
    seedLegacyRows(db);
    db.exec(`
      DROP TABLE IF EXISTS workflow_remediation_links;
      DROP TABLE IF EXISTS workflow_human_acceptances;
      DROP TABLE IF EXISTS workflow_verification_evidence;
      DROP TABLE IF EXISTS workflow_technical_verdicts;
      DROP TABLE IF EXISTS workflow_acceptance_criteria;
      DROP TABLE IF EXISTS workflow_recovery_actions;
      DROP TABLE IF EXISTS workflow_recovery_budgets;
      DROP TABLE IF EXISTS workflow_failure_observations;
      DROP INDEX IF EXISTS idx_workflow_attempt_scope_v34;
      DROP INDEX IF EXISTS idx_workflow_result_scope_v34;
      DROP INDEX IF EXISTS idx_workflow_blocker_scope_v34;
      DROP TABLE IF EXISTS workflow_work_checkpoints;
      DROP TABLE IF EXISTS workflow_decision_impacts;
      DROP TABLE IF EXISTS workflow_conversation_decisions;
      DROP TABLE IF EXISTS workflow_answers;
      DROP TABLE IF EXISTS workflow_interaction_options;
      DROP TABLE IF EXISTS workflow_interactions;
      DROP TABLE IF EXISTS workflow_question_dependencies;
      DROP TABLE IF EXISTS workflow_open_questions;
      DROP TABLE IF EXISTS workflow_milestone_contexts;
      DELETE FROM schema_version;
      INSERT INTO schema_version (version, applied_at)
      VALUES (32, '2026-07-12T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

afterEach(() => {
  _setMigrationFaultForTest(false);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("fresh v33 databases expose exact Milestone and Interaction Kind vocabularies", () => {
  assert.ok(SCHEMA_VERSION >= 33);
  const { db } = openFreshFixture();
  try {
    for (const table of [
      "workflow_milestone_contexts",
      "workflow_open_questions",
      "workflow_question_dependencies",
      "workflow_interactions",
      "workflow_interaction_options",
      "workflow_answers",
      "workflow_conversation_decisions",
      "workflow_decision_impacts",
      "workflow_work_checkpoints",
    ]) {
      assert.equal(tableExists(db, table), true, `${table} should exist`);
    }
    assert.equal(
      db.prepare(`
        SELECT 1 AS present FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_workflow_interactions_question'
      `).get(),
      undefined,
    );
    insertOperations(db, 3);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);

    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_open_questions (
          question_id, project_id, lifecycle_id, question_text, question_status,
          state_version, accepted_answer_id, created_at, updated_at,
          created_operation_id, created_project_revision, created_authority_epoch,
          last_operation_id, last_project_revision, last_authority_epoch
        ) VALUES ('question-preanswered', ?, 'life-disc', 'Skipped question',
          'answered', 1, 'fabricated-answer', '', '', 'op-2', 2, 0, 'op-2', 2, 0)
      `).run(projectId(db)),
      /question must begin open/,
    );

    for (const [index, kind] of [
      "discovery", "research", "requirements", "roadmap", "delivery", "remediation",
    ].entries()) {
      db.exec("SAVEPOINT milestone_kind");
      db.prepare(`
        INSERT INTO workflow_milestone_contexts (
          context_id, project_id, lifecycle_id, milestone_id, milestone_kind,
          horizon_note, created_at, operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'life-disc', 'M-DISC', ?, '', '', 'op-2', 2, 0)
      `).run(`context-${index}`, projectId(db), kind);
      db.exec("ROLLBACK TO milestone_kind");
      db.exec("RELEASE milestone_kind");
    }
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_milestone_contexts (
          context_id, project_id, lifecycle_id, milestone_id, milestone_kind,
          horizon_note, created_at, operation_id, project_revision, authority_epoch
        ) VALUES ('bad-kind', ?, 'life-disc', 'M-DISC', 'planning', '', '', 'op-2', 2, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );
    insertQuestion(db, "question-kinds", "life-disc", "op-2", 2);
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_interactions (
          interaction_id, project_id, question_id, sequence, interaction_kind,
          presentation_state, focused_prompt, requires_answer, option_count,
          recommended_option_id, recommendation_text, recommendation_rationale,
          recommendation_evidence, recommendation_confidence,
          recommendation_uncertainty, revisit_condition, presented_at,
          operation_id, project_revision, authority_epoch
        ) VALUES ('choice-no-answer', ?, 'question-kinds', 7, 'choice',
          'prepared', 'Prompt', 0, 2, 'option-1', '', '', '', NULL, '', '', '',
          'op-3', 3, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );

    for (const [index, kind] of [
      "open", "choice", "clarification", "recap", "consent", "subjective-uat",
    ].entries()) {
      db.exec("SAVEPOINT interaction_kind");
      db.prepare(`
        INSERT INTO workflow_interactions (
          interaction_id, project_id, question_id, sequence, interaction_kind,
          presentation_state, focused_prompt, requires_answer, option_count,
          recommendation_text, recommendation_rationale,
          recommendation_evidence, recommendation_confidence,
          recommendation_uncertainty, revisit_condition, presented_at,
          operation_id, project_revision, authority_epoch
        ) VALUES (?, ?, 'question-kinds', ?, ?, 'prepared', 'One focused prompt',
          ?, 0, ?, ?, '', 0.8, '', '', '', 'op-3', 3, 0)
      `).run(
        `interaction-${index}`,
        projectId(db),
        index + 1,
        kind,
        kind === "recap" ? 0 : 1,
        kind === "recap" ? "" : "Recommended route",
        kind === "recap" ? "" : "Plain-language reason",
      );
      db.exec("ROLLBACK TO interaction_kind");
      db.exec("RELEASE interaction_kind");
    }
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_interactions (
          interaction_id, project_id, question_id, sequence, interaction_kind,
          presentation_state, focused_prompt, requires_answer, option_count,
          recommendation_text, recommendation_rationale,
          recommendation_evidence, recommendation_confidence,
          recommendation_uncertainty, revisit_condition, presented_at,
          operation_id, project_revision, authority_epoch
        ) VALUES ('bad-interaction', ?, 'question-kinds', 1, 'decision',
          'prepared', 'Prompt', 1, 0, 'Route', 'Reason', '', 0.8, '', '', '', 'op-3', 3, 0)
      `).run(projectId(db)),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("planning horizons remain advisory even when stale or reforecast", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 3);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    db.prepare(`
      INSERT INTO workflow_milestone_contexts (
        context_id, project_id, lifecycle_id, milestone_id, milestone_kind,
        planned_start_at, planned_end_at, review_at, horizon_note,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('context-1', ?, 'life-disc', 'M-DISC', 'discovery',
        '2020-01-01', '2020-01-31', '2020-01-15', 'advisory only',
        '', 'op-2', 2, 0)
    `).run(projectId(db));
    db.prepare(`
      INSERT INTO workflow_milestone_contexts (
        context_id, project_id, lifecycle_id, milestone_id, milestone_kind,
        planned_start_at, planned_end_at, review_at, horizon_note,
        supersedes_context_id, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('context-2', ?, 'life-disc', 'M-DISC', 'discovery',
        '2020-02-01', '2020-02-29', '2020-02-15', 'reforecast without blocking',
        'context-1', '', 'op-3', 3, 0)
    `).run(projectId(db));

    assert.equal(db.prepare("SELECT status FROM milestones WHERE id = 'M-DISC'").get()?.status, "active");
    assert.equal(
      db.prepare("SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'life-disc'").get()?.lifecycle_status,
      "in_progress",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_blockers").get()?.count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_execution_attempts").get()?.count, 0);
  } finally {
    db.close();
  }
});

test("choice interactions require recommendation-first options and durable rationale", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 4);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    insertQuestion(db, "question-route", "life-disc", "op-2", 2);
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_interactions (
          interaction_id, project_id, question_id, sequence, interaction_kind,
          presentation_state, focused_prompt, requires_answer, option_count,
          recommended_option_id, recommendation_text, recommendation_rationale,
          recommendation_evidence, recommendation_confidence,
          recommendation_uncertainty, revisit_condition, presented_at,
          operation_id, project_revision, authority_epoch
        ) VALUES ('interaction-direct-presented', ?, 'question-route', 1, 'choice',
          'presented', 'Prompt', 1, 2, 'option-recommended', 'Route', 'Reason',
          '', 0.8, '', '', '', 'op-3', 3, 0)
      `).run(projectId(db)),
      /interaction must begin prepared/,
    );
    insertPresentedChoice(db, {
      interactionId: "interaction-valid",
      questionId: "question-route",
      sequence: 1,
      operationId: "op-3",
      revision: 3,
    });
    assert.deepEqual(
      db.prepare(`
        SELECT option_id, ordinal FROM workflow_interaction_options
        WHERE interaction_id = 'interaction-valid' ORDER BY ordinal
      `).all().map((row) => ({ ...row })),
      [
        { option_id: "option-recommended", ordinal: 1 },
        { option_id: "option-alternate", ordinal: 2 },
      ],
    );
    assert.throws(
      () => insertPresentedChoice(db, {
        interactionId: "interaction-wrong-order",
        questionId: "question-route",
        sequence: 2,
        operationId: "op-4",
        revision: 4,
        recommendedOrdinal: 2,
      }),
      /recommended option must be first/,
    );
    assert.throws(
      () => db.exec(`
        UPDATE workflow_interaction_options
        SET description = 'rewritten'
        WHERE interaction_id = 'interaction-valid' AND option_id = 'option-recommended'
      `),
      /immutable/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_interaction_options (
          interaction_id, option_id, project_id, ordinal, label, description,
          operation_id, project_revision, authority_epoch
        ) VALUES ('interaction-valid', 'option-late', ?, 3, 'Late option',
          'Must not alter a presented choice.', 'op-3', 3, 0)
      `).run(projectId(db)),
      /options may only be added while interaction is prepared/,
    );
  } finally {
    db.close();
  }
});

test("verbatim pushback stays distinct from interpretation and closes only through its accepted Answer", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 4);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    insertQuestion(db, "question-route", "life-disc", "op-2", 2);
    insertPresentedChoice(db, {
      interactionId: "interaction-route",
      questionId: "question-route",
      sequence: 1,
      operationId: "op-3",
      revision: 3,
    });
    assert.throws(
      () => db.prepare(`
        UPDATE workflow_open_questions
        SET question_status = 'answered', accepted_answer_id = 'missing-answer',
            state_version = 1, updated_at = '2026-07-12T00:04:00.000Z',
            last_operation_id = 'op-4', last_project_revision = 4
        WHERE question_id = 'question-route'
      `).run(),
      /constraint|invalid open question transition/i,
    );
    const verbatim = "your lean — but do not rely on GitHub tags";
    insertAcceptedAnswer(db, {
      answerId: "answer-pushback",
      interactionId: "interaction-route",
      questionId: "question-route",
      operationId: "op-4",
      revision: 4,
      responseKind: "pushback",
      verbatim,
      normalized: "accept_recommendation_with_constraint",
      selectedOptionId: null,
    });
    assert.deepEqual(
      { ...db.prepare(`
        SELECT verbatim_response, normalized_interpretation
        FROM workflow_answers WHERE answer_id = 'answer-pushback'
      `).get() },
      {
        verbatim_response: verbatim,
        normalized_interpretation: "accept_recommendation_with_constraint",
      },
    );
    assert.throws(
      () => db.exec("UPDATE workflow_answers SET normalized_interpretation = 'other' WHERE answer_id = 'answer-pushback'"),
      /immutable/,
    );
    assert.throws(
      () => db.exec("DELETE FROM workflow_answers WHERE answer_id = 'answer-pushback'"),
      /immutable/,
    );
    db.prepare(`
      UPDATE workflow_open_questions
      SET question_status = 'answered', accepted_answer_id = 'answer-pushback',
          state_version = 1, updated_at = '2026-07-12T00:04:00.000Z',
          last_operation_id = 'op-4', last_project_revision = 4
      WHERE question_id = 'question-route'
    `).run();
    assert.equal(
      db.prepare("SELECT question_status FROM workflow_open_questions WHERE question_id = 'question-route'").get()?.question_status,
      "answered",
    );
  } finally {
    db.close();
  }
});

test("presented recaps accept corrections without becoming answer gates", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 5);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    insertQuestion(db, "question-route", "life-disc", "op-2", 2);
    insertPresentedChoice(db, {
      interactionId: "interaction-choice", questionId: "question-route", sequence: 1,
      operationId: "op-3", revision: 3,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-choice", interactionId: "interaction-choice", questionId: "question-route",
      operationId: "op-4", revision: 4,
    });
    insertDecision(db, {
      decisionId: "decision-choice", questionId: "question-route", answerId: "answer-choice",
      operationId: "op-4", revision: 4,
    });
    insertPresentedRecap(db, {
      interactionId: "interaction-recap", questionId: "question-route", sequence: 2,
      operationId: "op-4", revision: 4,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-correction", interactionId: "interaction-recap", questionId: "question-route",
      responseKind: "correction", verbatim: "That recap is wrong; use files first.",
      normalized: "select_files_first", selectedOptionId: null,
      operationId: "op-5", revision: 5,
    });
    insertDecision(db, {
      decisionId: "decision-correction", questionId: "question-route", answerId: "answer-correction",
      supersedesDecisionId: "decision-choice", text: "Use files first.",
      operationId: "op-5", revision: 5,
    });

    assert.equal(
      db.prepare("SELECT requires_answer FROM workflow_interactions WHERE interaction_id = 'interaction-recap'").get()?.requires_answer,
      0,
    );
    assert.equal(
      db.prepare("SELECT supersedes_decision_id FROM workflow_conversation_decisions WHERE decision_id = 'decision-correction'").get()?.supersedes_decision_id,
      "decision-choice",
    );
  } finally {
    db.close();
  }
});

test("corrections supersede Decisions and target only dependency-reachable work for revalidation", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 11);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    insertMilestoneLifecycle(db, "life-other", "M-OTHER", "op-2", 2);
    insertQuestion(db, "question-route", "life-disc", "op-3", 3);
    db.prepare(`
      INSERT INTO workflow_question_dependencies (
        question_id, lifecycle_id, project_id, dependency_kind,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('question-route', 'life-disc', ?, 'revalidate', '', 'op-3', 3, 0)
    `).run(projectId(db));
    insertPresentedChoice(db, {
      interactionId: "interaction-1", questionId: "question-route", sequence: 1,
      operationId: "op-4", revision: 4,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-1", interactionId: "interaction-1", questionId: "question-route",
      operationId: "op-5", revision: 5,
    });
    db.prepare(`
      INSERT INTO workflow_answers (
        answer_id, project_id, question_id, interaction_id, response_kind,
        verbatim_response, selected_option_id, normalized_interpretation,
        interpretation_confidence, answer_disposition, observed_project_revision,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('answer-conflict', ?, 'question-route', 'interaction-1', 'answer',
        'Stale competing response', 'option-alternate', 'select_files_first',
        0.8, 'revision-conflict', 4, '', 'op-5', 5, 0)
    `).run(projectId(db));
    assert.throws(
      () => insertDecision(db, {
        decisionId: "decision-conflict", questionId: "question-route", answerId: "answer-conflict",
        operationId: "op-5", revision: 5,
      }),
      /accepted Answer/,
    );
    insertDecision(db, {
      decisionId: "decision-1", questionId: "question-route", answerId: "answer-1",
      operationId: "op-5", revision: 5,
    });
    insertPresentedChoice(db, {
      interactionId: "interaction-2", questionId: "question-route", sequence: 2,
      kind: "clarification", operationId: "op-6", revision: 6,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-2", interactionId: "interaction-2", questionId: "question-route",
      responseKind: "correction", verbatim: "Use the alternate only for M-DISC.",
      normalized: "correct_route_for_discovery", selectedOptionId: "option-alternate",
      operationId: "op-7", revision: 7,
    });
    insertDecision(db, {
      decisionId: "decision-2", questionId: "question-route", answerId: "answer-2",
      supersedesDecisionId: "decision-1", text: "Use the alternate only for discovery.",
      operationId: "op-7", revision: 7,
    });
    db.prepare(`
      INSERT INTO workflow_decision_impacts (
        decision_id, lifecycle_id, project_id, effect,
        operation_id, project_revision, authority_epoch
      ) VALUES ('decision-2', 'life-disc', ?, 'revalidate', 'op-7', 7, 0)
    `).run(projectId(db));
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_decision_impacts (
          decision_id, lifecycle_id, project_id, effect,
          operation_id, project_revision, authority_epoch
        ) VALUES ('decision-2', 'life-disc', ?, 'invalidate', 'op-7', 7, 0)
      `).run(projectId(db)),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_decision_impacts (
          decision_id, lifecycle_id, project_id, effect,
          operation_id, project_revision, authority_epoch
        ) VALUES ('decision-2', 'life-other', ?, 'revalidate', 'op-7', 7, 0)
      `).run(projectId(db)),
      /dependency-reachable/,
    );

    assert.equal(
      db.prepare("SELECT decision_text FROM workflow_conversation_decisions WHERE decision_id = 'decision-1'").get()?.decision_text,
      "Use the database-first route.",
    );
    insertPresentedChoice(db, {
      interactionId: "interaction-3", questionId: "question-route", sequence: 3,
      kind: "clarification", operationId: "op-8", revision: 8,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-3", interactionId: "interaction-3", questionId: "question-route",
      responseKind: "answer", verbatim: "Return to the original route.",
      normalized: "restore_original_route", selectedOptionId: "option-recommended",
      operationId: "op-9", revision: 9,
    });
    assert.throws(
      () => insertDecision(db, {
        decisionId: "decision-not-correction", questionId: "question-route", answerId: "answer-3",
        supersedesDecisionId: "decision-2", operationId: "op-9", revision: 9,
      }),
      /correction Answer/,
    );
    insertPresentedChoice(db, {
      interactionId: "interaction-4", questionId: "question-route", sequence: 4,
      kind: "clarification", operationId: "op-10", revision: 10,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-4", interactionId: "interaction-4", questionId: "question-route",
      responseKind: "correction", verbatim: "Return to the original route.",
      normalized: "restore_original_route", selectedOptionId: "option-recommended",
      operationId: "op-11", revision: 11,
    });
    assert.throws(
      () => insertDecision(db, {
        decisionId: "decision-fork", questionId: "question-route", answerId: "answer-4",
        supersedesDecisionId: "decision-1", operationId: "op-11", revision: 11,
      }),
      /current head/,
    );
    assert.throws(
      () => db.exec("UPDATE workflow_conversation_decisions SET decision_text = 'rewritten' WHERE decision_id = 'decision-1'"),
      /immutable/,
    );
  } finally {
    db.close();
  }
});

test("decision impacts cannot invalidate inform-only dependencies", () => {
  const { db } = openFreshFixture();
  try {
    insertOperations(db, 5);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    insertMilestoneLifecycle(db, "life-other", "M-OTHER", "op-2", 2);
    insertQuestion(db, "question-route", "life-disc", "op-3", 3);
    db.prepare(`
      INSERT INTO workflow_question_dependencies (
        question_id, lifecycle_id, project_id, dependency_kind,
        created_at, operation_id, project_revision, authority_epoch
      ) VALUES ('question-route', 'life-other', ?, 'inform', '', 'op-3', 3, 0)
    `).run(projectId(db));
    insertPresentedChoice(db, {
      interactionId: "interaction-route", questionId: "question-route", sequence: 1,
      operationId: "op-4", revision: 4,
    });
    insertAcceptedAnswer(db, {
      answerId: "answer-route", interactionId: "interaction-route", questionId: "question-route",
      operationId: "op-5", revision: 5,
    });
    insertDecision(db, {
      decisionId: "decision-route", questionId: "question-route", answerId: "answer-route",
      operationId: "op-5", revision: 5,
    });

    assert.throws(
      () => db.prepare(`
        INSERT INTO workflow_decision_impacts (
          decision_id, lifecycle_id, project_id, effect,
          operation_id, project_revision, authority_epoch
        ) VALUES ('decision-route', 'life-other', ?, 'invalidate', 'op-5', 5, 0)
      `).run(projectId(db)),
      /dependency-reachable/,
    );
    db.prepare(`
      INSERT INTO workflow_decision_impacts (
        decision_id, lifecycle_id, project_id, effect,
        operation_id, project_revision, authority_epoch
      ) VALUES ('decision-route', 'life-other', ?, 'inform', 'op-5', 5, 0)
    `).run(projectId(db));
  } finally {
    db.close();
  }
});

test("Work Checkpoints preserve a single restart-safe head without erasing history", () => {
  const { dbPath, db } = openFreshFixture();
  try {
    insertOperations(db, 4);
    insertMilestoneLifecycle(db, "life-disc", "M-DISC", "op-1", 1);
    db.prepare(`
      INSERT INTO workflow_work_checkpoints (
        checkpoint_id, project_id, scope_key, lifecycle_id, checkpoint_kind,
        sequence, confirmed_context, unresolved_summary, evidence_summary,
        suggested_next_action, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('checkpoint-1', ?, 'life-disc', 'life-disc', 'research',
        1, 'User outcome confirmed', 'One route remains open', 'Research batch 1',
        'Ask the next focused question', '', 'op-2', 2, 0)
    `).run(projectId(db));
  } finally {
    db.close();
  }

  assert.equal(openDatabase(dbPath), true);
  const reopened = _getAdapter()!;
  reopened.prepare(`
    INSERT INTO workflow_work_checkpoints (
      checkpoint_id, project_id, scope_key, lifecycle_id, checkpoint_kind,
      sequence, previous_checkpoint_id,
      confirmed_context, unresolved_summary, evidence_summary,
      suggested_next_action, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES ('checkpoint-2', ?, 'life-disc', 'life-disc', 'recap',
      2, 'checkpoint-1', 'Outcome and route confirmed', 'No unresolved choice',
      'Answer recorded', 'Continue reversible research', '', 'op-3', 3, 0)
  `).run(projectId(reopened as unknown as RawDb));
  assert.deepEqual(
    reopened.prepare(`
      SELECT checkpoint_id, sequence, previous_checkpoint_id
      FROM workflow_work_checkpoints
      WHERE scope_key = 'life-disc' ORDER BY sequence
    `).all(),
    [
      { checkpoint_id: "checkpoint-1", sequence: 1, previous_checkpoint_id: null },
      { checkpoint_id: "checkpoint-2", sequence: 2, previous_checkpoint_id: "checkpoint-1" },
    ],
  );
  assert.deepEqual(
    reopened.prepare(`
      SELECT checkpoint_id FROM workflow_work_checkpoints checkpoint
      WHERE scope_key = 'life-disc' AND NOT EXISTS (
        SELECT 1 FROM workflow_work_checkpoints successor
        WHERE successor.previous_checkpoint_id = checkpoint.checkpoint_id
      )
    `).all(),
    [{ checkpoint_id: "checkpoint-2" }],
  );
  assert.throws(
    () => reopened.prepare(`
      INSERT INTO workflow_work_checkpoints (
        checkpoint_id, project_id, scope_key, lifecycle_id, checkpoint_kind,
        sequence, previous_checkpoint_id,
        confirmed_context, unresolved_summary, evidence_summary,
        suggested_next_action, created_at,
        operation_id, project_revision, authority_epoch
      ) VALUES ('checkpoint-fork', ?, 'life-disc', 'life-disc', 'recap',
        3, 'checkpoint-1', '', '', '', '', '', 'op-4', 4, 0)
    `).run(projectId(reopened as unknown as RawDb)),
    /current head/,
  );
});

test("v32 upgrade is additive, backed up, and does not reinterpret legacy rows", (t) => {
  const dbPath = createDatabasePath();
  rewindToV32(dbPath);
  const beforeUpgrade = openRawDatabase(dbPath);
  t.after(() => {
    if (beforeUpgrade.isOpen) beforeUpgrade.close();
  });
  assertV34Absent(beforeUpgrade);
  beforeUpgrade.close();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  const upgraded = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(upgraded), SCHEMA_VERSION);
    assert.equal(upgraded.prepare("SELECT status FROM milestones WHERE id = 'M-DISC'").get()?.status, "active");
    assert.equal(upgraded.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Preserve me");
    for (const table of [
      "workflow_milestone_contexts", "workflow_open_questions", "workflow_question_dependencies",
      "workflow_interactions", "workflow_interaction_options", "workflow_answers",
      "workflow_conversation_decisions", "workflow_decision_impacts", "workflow_work_checkpoints",
    ]) {
      assert.equal(upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    }
    assert.equal(upgraded.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    upgraded.close();
  }

  const backup = openRawDatabase(`${dbPath}.backup-v32`);
  try {
    assert.equal(maxSchemaVersion(backup), 32);
    assert.equal(tableExists(backup, "workflow_open_questions"), false);
    assertV34Absent(backup);
    assert.equal(backup.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Preserve me");
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    backup.close();
  }

  const restoredPath = join(dirname(dbPath), "restored.db");
  copyFileSync(`${dbPath}.backup-v32`, restoredPath);
  assert.equal(openDatabase(restoredPath), true);
  closeDatabase();
  const restored = openRawDatabase(restoredPath);
  try {
    assert.equal(maxSchemaVersion(restored), SCHEMA_VERSION);
    assert.equal(restored.prepare("SELECT COUNT(*) AS count FROM workflow_open_questions").get()?.count, 0);
  } finally {
    restored.close();
  }
});

test("v32 upgrade replaces a stale same-version backup", () => {
  const dbPath = createDatabasePath();
  rewindToV32(dbPath);
  copyFileSync(dbPath, `${dbPath}.backup-v32`);
  const current = openRawDatabase(dbPath);
  try {
    current.prepare("UPDATE decisions SET decision = 'Current state' WHERE id = 'D-LEGACY'").run();
  } finally {
    current.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  const backup = openRawDatabase(`${dbPath}.backup-v32`);
  try {
    assert.equal(maxSchemaVersion(backup), 32);
    assert.equal(backup.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Current state");
    assert.equal(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  } finally {
    backup.close();
  }
});

test("faulted v32 migration rolls back all v33 state and retries cleanly", () => {
  const dbPath = createDatabasePath();
  rewindToV32(dbPath);
  _setMigrationFaultForTest(true);
  assert.throws(() => openDatabase(dbPath), /migration fault injected/);
  _setMigrationFaultForTest(false);

  const rolledBack = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(rolledBack), 32);
    assertV34Absent(rolledBack);
    for (const table of [
      "workflow_milestone_contexts", "workflow_open_questions", "workflow_question_dependencies",
      "workflow_interactions", "workflow_interaction_options", "workflow_answers",
      "workflow_conversation_decisions", "workflow_decision_impacts", "workflow_work_checkpoints",
    ]) {
      assert.equal(tableExists(rolledBack, table), false, `${table} should roll back`);
    }
    assert.equal(rolledBack.prepare("SELECT decision FROM decisions WHERE id = 'D-LEGACY'").get()?.decision, "Preserve me");
  } finally {
    rolledBack.close();
  }

  assert.equal(openDatabase(dbPath), true);
  closeDatabase();
  const retried = openRawDatabase(dbPath);
  try {
    assert.equal(maxSchemaVersion(retried), SCHEMA_VERSION);
    assert.equal(tableExists(retried, "workflow_work_checkpoints"), true);
    assert.equal(retried.prepare("SELECT COUNT(*) AS count FROM workflow_open_questions").get()?.count, 0);
  } finally {
    retried.close();
  }
});
