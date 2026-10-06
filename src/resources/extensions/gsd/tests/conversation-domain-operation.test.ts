// gsd-pi - Conversation Domain Operation tests: an answered ask_user_questions
// round as Open Question, interaction, option and Answer rows.

import test from "node:test";
import assert from "node:assert/strict";

import {
  recordAnsweredQuestionRound,
  type QuestionRoundQuestion,
} from "../conversation-domain-operation.ts";
import { _setDomainOperationFaultForTest, noteSessionRead, runInToolSession } from "../db/domain-operation.ts";
import { pruneArtifactRows } from "../db/writers/artifact-row-prune.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { _getAdapter, closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";
import { registerMilestones } from "../milestone-registration.ts";

const SCOPE: QuestionRoundQuestion = {
  id: "scope",
  header: "Scope",
  question: "What is out of scope?",
  options: [
    { label: "Sync (Recommended)", description: "No sync in this milestone." },
    { label: "Nothing", description: "Everything is in scope." },
  ],
};

const DEPTH_GATE: QuestionRoundQuestion = {
  id: "depth_verification_M001_confirm",
  header: "Depth Check",
  question: "Did I capture the depth right?",
  options: [
    { label: "Yes, you got it (Recommended)", description: "The summary is correct." },
    { label: "Not quite", description: "Let me clarify." },
  ],
};

/** A database with Milestone M001 and its lifecycle row. */
function openProject(t: { after(fn: () => void): void }): void {
  assert.equal(openDatabase(":memory:"), true);
  t.after(() => closeDatabase());
  registerMilestones([{ id: "M001", title: "First" }], "test");
}

function rows(sql: string): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(sql).all().map((row) => ({ ...row }));
}

function count(table: string): number {
  return Number(rows(`SELECT COUNT(*) AS count FROM ${table}`)[0]!["count"]);
}

const ANSWERED_ROUND_SQL = `
  SELECT lifecycle.milestone_id, question.question_text, question.question_status,
         interaction.interaction_kind, interaction.presentation_state,
         interaction.recommendation_text, interaction.recommendation_rationale,
         answer.response_kind, answer.verbatim_response, answer.selected_option_id,
         answer.normalized_interpretation, answer.answer_disposition
  FROM workflow_open_questions question
  JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = question.lifecycle_id
  JOIN workflow_interactions interaction ON interaction.question_id = question.question_id
  JOIN workflow_answers answer ON answer.answer_id = question.accepted_answer_id
  ORDER BY question.question_text
`;

test("an answered choice is an answered Open Question with its options and accepted Answer", (t) => {
  openProject(t);

  const result = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing", notes: "we do all of it" } },
  });

  assert.deepEqual(result, { stored: ["scope"], skipped: [] });
  assert.deepEqual(rows(ANSWERED_ROUND_SQL), [{
    milestone_id: "M001",
    question_text: "What is out of scope?",
    question_status: "answered",
    interaction_kind: "choice",
    presentation_state: "presented",
    recommendation_text: "Sync (Recommended)",
    recommendation_rationale: "No sync in this milestone.",
    response_kind: "answer",
    verbatim_response: "Nothing\nuser_note: we do all of it",
    selected_option_id: "option-2",
    normalized_interpretation: "Nothing",
    answer_disposition: "accepted",
  }]);
  assert.deepEqual(
    rows("SELECT option_id, ordinal, label, description FROM workflow_interaction_options ORDER BY ordinal"),
    [
      { option_id: "option-1", ordinal: 1, label: "Sync (Recommended)", description: "No sync in this milestone." },
      { option_id: "option-2", ordinal: 2, label: "Nothing", description: "Everything is in scope." },
    ],
  );
  assert.deepEqual(
    rows(`
      SELECT operation.operation_type, operation.actor_type, event.event_type,
             json_extract(event.payload_json, '$.promptId') AS prompt_id
      FROM workflow_operations operation
      JOIN workflow_domain_events event ON event.operation_id = operation.operation_id
      WHERE operation.operation_type LIKE 'conversation.%'
      ORDER BY operation.resulting_revision
    `),
    [
      { operation_type: "conversation.question.ask", actor_type: "agent", event_type: "conversation.question.asked", prompt_id: "scope" },
      { operation_type: "conversation.question.answer", actor_type: "user", event_type: "conversation.question.answered", prompt_id: "scope" },
    ],
    "the question and the answer are written by Domain Operations, and the events keep the tool question id",
  );
});

test("a confirmed gate question is a consent interaction with a consent Answer; a decline is not consent", (t) => {
  openProject(t);

  recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-decline",
    questions: [DEPTH_GATE],
    answers: { [DEPTH_GATE.id!]: { selected: "Not quite" } },
  });
  recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-confirm",
    questions: [DEPTH_GATE],
    answers: { [DEPTH_GATE.id!]: { selected: "Yes, you got it (Recommended)" } },
  });

  assert.deepEqual(
    rows(`
      SELECT interaction.interaction_kind, answer.response_kind, answer.selected_option_id
      FROM workflow_answers answer
      JOIN workflow_interactions interaction ON interaction.interaction_id = answer.interaction_id
      ORDER BY answer.project_revision
    `),
    [
      { interaction_kind: "consent", response_kind: "answer", selected_option_id: "option-2" },
      { interaction_kind: "consent", response_kind: "consent", selected_option_id: "option-1" },
    ],
  );
});

test("a free-form reply is stored verbatim as pushback, and several selections keep every label", (t) => {
  openProject(t);

  recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE, { ...SCOPE, id: "targets", question: "Which targets ship first?", allowMultiple: true }],
    answers: {
      scope: { selected: "None of the above", notes: "Only the export is out." },
      targets: { selected: ["Sync (Recommended)", "Nothing"] },
    },
  });

  assert.deepEqual(
    rows(ANSWERED_ROUND_SQL).map((row) => ({
      question: row["question_text"],
      kind: row["response_kind"],
      verbatim: row["verbatim_response"],
      option: row["selected_option_id"],
      interpretation: row["normalized_interpretation"],
    })),
    [
      {
        question: "What is out of scope?",
        kind: "pushback",
        verbatim: "None of the above\nuser_note: Only the export is out.",
        option: null,
        interpretation: "Only the export is out.",
      },
      {
        question: "Which targets ship first?",
        kind: "answer",
        verbatim: "Sync (Recommended)\nNothing",
        option: null,
        interpretation: "Sync (Recommended), Nothing",
      },
    ],
  );
  assert.deepEqual(
    rows(`
      SELECT json_extract(payload_json, '$.promptId') AS prompt_id,
             json_extract(payload_json, '$.allowMultiple') AS allow_multiple
      FROM workflow_domain_events WHERE event_type = 'conversation.question.asked'
      ORDER BY event_index
    `),
    [{ prompt_id: "scope", allow_multiple: 0 }, { prompt_id: "targets", allow_multiple: 1 }],
  );
});

test("a question that does not fit the interaction contract is reported and the rest of the round is stored", (t) => {
  openProject(t);
  const fourOptions = {
    ...SCOPE,
    id: "many",
    options: [...SCOPE.options!, { label: "Export", description: "No export." }, { label: "Import", description: "No import." }],
  };
  const noRationale = { ...SCOPE, id: "bare", options: [{ label: "A", description: " " }, { label: "B", description: "b" }] };

  const result = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [fourOptions, noRationale, { ...SCOPE, id: "unanswered" }, SCOPE],
    answers: {
      many: { selected: "Export" },
      bare: { selected: "A" },
      unanswered: { selected: "" },
      scope: { selected: "Sync (Recommended)" },
    },
  });

  assert.deepEqual(result.stored, ["scope"]);
  assert.deepEqual(result.skipped, [
    { id: "many", reason: "an interaction holds 2 or 3 options (got 4)" },
    { id: "bare", reason: "the recommended option has no description to store as the rationale" },
    { id: "unanswered", reason: "the question has no answer" },
  ]);
  assert.equal(count("workflow_open_questions"), 1);
  assert.equal(count("workflow_answers"), 1);
});

test("a Milestone with no lifecycle row stores no question and runs no operation", (t) => {
  assert.equal(openDatabase(":memory:"), true);
  t.after(() => closeDatabase());
  insertMilestone({ id: "M001", title: "Unadopted", status: "queued" });

  const result = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  });

  assert.deepEqual(result, { stored: [], skipped: [{ id: "scope", reason: "milestone M001 has no lifecycle row" }] });
  assert.equal(count("workflow_open_questions"), 0);
  assert.equal(count("workflow_operations"), 0);
});

test("the same tool call recorded twice stores the round once", (t) => {
  openProject(t);
  const round = {
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  };

  const first = recordAnsweredQuestionRound(round);
  const second = recordAnsweredQuestionRound(round);

  assert.deepEqual(first, { stored: ["scope"], skipped: [] });
  assert.deepEqual(second, first);
  assert.equal(count("workflow_open_questions"), 1);
  assert.equal(count("workflow_answers"), 1);
  assert.deepEqual(rows("SELECT question_status FROM workflow_open_questions"), [{ question_status: "answered" }]);
});

test("a provider that reuses one tool call id for every round has every round stored", (t) => {
  openProject(t);
  // Ollama numbers tool calls per message, so each round has this id.
  const toolCallId = "ollama_tc_0";

  const declined = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId,
    questions: [DEPTH_GATE],
    answers: { [DEPTH_GATE.id!]: { selected: "Not quite" } },
  });
  const confirmed = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId,
    questions: [DEPTH_GATE],
    answers: { [DEPTH_GATE.id!]: { selected: "Yes, you got it (Recommended)" } },
  });
  const otherQuestion = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId,
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  });

  assert.deepEqual(declined, { stored: [DEPTH_GATE.id], skipped: [] });
  assert.deepEqual(confirmed, { stored: [DEPTH_GATE.id], skipped: [] });
  assert.deepEqual(otherQuestion, { stored: ["scope"], skipped: [] });
  assert.deepEqual(
    rows(`
      SELECT question.question_text, question.question_status, answer.response_kind, answer.selected_option_id
      FROM workflow_open_questions question
      LEFT JOIN workflow_answers answer ON answer.answer_id = question.accepted_answer_id
      ORDER BY question.created_project_revision
    `),
    [
      { question_text: DEPTH_GATE.question, question_status: "answered", response_kind: "answer", selected_option_id: "option-2" },
      { question_text: DEPTH_GATE.question, question_status: "answered", response_kind: "consent", selected_option_id: "option-1" },
      { question_text: SCOPE.question, question_status: "answered", response_kind: "answer", selected_option_id: "option-2" },
    ],
    "the decline, the consent and the later question each have an accepted Answer",
  );
});

test("a round with a blank tool call id is stored", (t) => {
  openProject(t);

  const result = recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  });

  assert.deepEqual(result, { stored: ["scope"], skipped: [] });
  assert.deepEqual(rows("SELECT question_status FROM workflow_open_questions"), [{ question_status: "answered" }]);
});

test("an answer that cannot be stored leaves its question open and reported, and the next call stores the answer", (t) => {
  openProject(t);
  t.after(() => _setDomainOperationFaultForTest(null));
  const round = {
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  };

  _setDomainOperationFaultForTest("after-mutation", "conversation.question.answer");
  assert.deepEqual(recordAnsweredQuestionRound(round), {
    stored: [],
    skipped: [{
      id: "scope",
      reason: "the answer was not stored and the question stays open: domain operation fault: after-mutation",
    }],
  });

  assert.deepEqual(
    rows("SELECT question_status, accepted_answer_id FROM workflow_open_questions"),
    [{ question_status: "open", accepted_answer_id: null }],
  );
  assert.equal(count("workflow_answers"), 0);
  assert.deepEqual(
    rows("SELECT operation_type FROM workflow_operations WHERE operation_type LIKE 'conversation.%'"),
    [{ operation_type: "conversation.question.ask" }],
    "a failed answer adds no third operation",
  );

  _setDomainOperationFaultForTest(null);
  assert.deepEqual(recordAnsweredQuestionRound(round), { stored: ["scope"], skipped: [] });
  assert.equal(count("workflow_open_questions"), 1);
  assert.deepEqual(
    rows(ANSWERED_ROUND_SQL).map((row) => [row["question_status"], row["verbatim_response"]]),
    [["answered", "Nothing"]],
  );
});

test("a round whose ask was committed with no answer gets its answer on the next call", (t) => {
  openProject(t);
  t.after(() => _setDomainOperationFaultForTest(null));
  const round = {
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  };

  // The process stops between the two operations: the ask is committed, the answer never runs.
  _setDomainOperationFaultForTest("after-commit", "conversation.question.ask");
  assert.throws(() => recordAnsweredQuestionRound(round), /domain operation fault: after-commit/);
  assert.deepEqual(rows("SELECT question_status FROM workflow_open_questions"), [{ question_status: "open" }]);

  _setDomainOperationFaultForTest(null);
  const result = recordAnsweredQuestionRound(round);

  assert.deepEqual(result, { stored: ["scope"], skipped: [] });
  assert.equal(count("workflow_open_questions"), 1);
  assert.deepEqual(
    rows(ANSWERED_ROUND_SQL).map((row) => [row["question_status"], row["verbatim_response"]]),
    [["answered", "Nothing"]],
  );
});

test("a stored round does not make the next write of a session that read before it stale", (t) => {
  openProject(t);
  const session = "round-after-read";
  const revision = readDomainOperationFence().revision;
  runInToolSession(session, () => noteSessionRead(revision));

  recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  });
  assert.equal(readDomainOperationFence().revision, revision + 2);

  assert.equal(
    runInToolSession(session, () => pruneArtifactRows({ name: "session-writer", actorType: "system" }, ["a.md"])),
    1,
  );
  assert.equal(readDomainOperationFence().revision, revision + 3);
});

test("a stored round and one other operation after the read make the next write of the session stale", (t) => {
  openProject(t);
  const session = "round-and-writer-after-read";
  const revision = readDomainOperationFence().revision;
  runInToolSession(session, () => noteSessionRead(revision));

  recordAnsweredQuestionRound({
    milestoneId: "M001",
    toolCallId: "call-1",
    questions: [SCOPE],
    answers: { scope: { selected: "Nothing" } },
  });
  pruneArtifactRows({ name: "other-writer", actorType: "system" }, ["b.md"]);

  assert.throws(
    () => runInToolSession(session, () => pruneArtifactRows({ name: "session-writer", actorType: "system" }, ["a.md"])),
    /stale view: the project changed after this session last read it/,
  );
  assert.equal(readDomainOperationFence().revision, revision + 3);
});
