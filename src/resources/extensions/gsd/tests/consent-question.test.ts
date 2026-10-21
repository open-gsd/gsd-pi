import test from "node:test";
import assert from "node:assert/strict";

import {
  type AnswerOutcome,
  classifyQuestion,
  evaluateAnswer,
  evaluateAskUserQuestionsRound,
  failPolicyForKind,
  formatUnansweredConsentQuestionMessage,
  isAwaitingUserInput,
  lastAssistantText,
  messageHasPendingAskUserQuestionsTool,
  shouldPauseForQuestion,
} from "../consent-question.ts";

const GATE_OPTIONS = [
  { label: "Yes, you got it (Recommended)" },
  { label: "Needs adjustment" },
];

const CONSENT_OPTIONS = [
  { label: "Option A (Recommended)" },
  { label: "Option B" },
];

function assistantMessage(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// ── Classification ──────────────────────────────────────────────────────────

test("classifyQuestion: gate ids, consent defaults, prose kinds", () => {
  assert.deepEqual(
    classifyQuestion({ id: "depth_verification_M001_confirm" }),
    { kind: "gate", gateSubKind: "approval" },
  );
  assert.deepEqual(
    classifyQuestion({ id: "depth_verification" }),
    { kind: "gate", gateSubKind: "depth-verification" },
  );
  assert.deepEqual(
    classifyQuestion({ id: "destructive_confirm_rm" }),
    { kind: "gate", gateSubKind: "destructive-confirm" },
  );
  // Any other structured question is a real elicitation → consent, fail-closed.
  assert.equal(classifyQuestion({ id: "m004_shape", options: CONSENT_OPTIONS }).kind, "consent");
  assert.equal(classifyQuestion({ id: "free_text_q" }).kind, "consent");
  // Prose classification.
  assert.equal(classifyQuestion({ text: "Should I proceed with the write?" }).kind, "consent");
  assert.equal(
    classifyQuestion({ text: "Want me to research this or skip?", unitType: "research-decision" }).kind,
    "decision",
  );
  assert.equal(classifyQuestion({ text: "Here is the summary of changes." }).kind, "informational");
});

test("failPolicyForKind: only informational is fail-open", () => {
  assert.equal(failPolicyForKind("gate"), "closed");
  assert.equal(failPolicyForKind("consent"), "closed");
  assert.equal(failPolicyForKind("decision"), "closed");
  assert.equal(failPolicyForKind("informational"), "open");
});

// ── Policy table: (kind × answer shape) → outcome ───────────────────────────

type Row = {
  name: string;
  question: { id: string; options?: Array<{ label?: string }> };
  details: Parameters<typeof evaluateAnswer>[0]["details"];
  expected: AnswerOutcome;
};

const gateQ = { id: "depth_verification_M001_confirm", options: GATE_OPTIONS };
const consentQ = { id: "boundary_choice", options: CONSENT_OPTIONS };

const POLICY_TABLE: Row[] = [
  // gate
  { name: "gate × confirm selected → verified", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: "Yes, you got it (Recommended)" } } } }, expected: "verified" },
  { name: "gate × decline selected → declined", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: "Needs adjustment" } } } }, expected: "declined" },
  { name: "gate × empty selected → waiting", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: "" } } } }, expected: "waiting" },
  { name: "gate × empty selected array → waiting", question: gateQ, details: { response: { answers: { [gateQ.id]: { selected: [] } } } }, expected: "waiting" },
  { name: "gate × missing response → waiting", question: gateQ, details: {}, expected: "waiting" },
  { name: "gate × notes-only → waiting (notes never satisfy a gate)", question: gateQ, details: { response: { answers: { [gateQ.id]: { notes: "looks fine" } } } }, expected: "waiting" },
  { name: "gate × cancelled → cancelled", question: gateQ, details: { cancelled: true, response: null }, expected: "cancelled" },
  { name: "gate × timed_out → timeout (#852)", question: gateQ, details: { cancelled: true, timed_out: true, response: null }, expected: "timeout" },
  { name: "gate × timed_out + interrupted → timeout (timeout wins, #852)", question: gateQ, details: { cancelled: true, timed_out: true, interrupted: true, response: null }, expected: "timeout" },
  // consent
  { name: "consent × valid selected → answered", question: consentQ, details: { response: { answers: { [consentQ.id]: { selected: "Option B" } } } }, expected: "answered" },
  { name: "consent × empty selected → waiting (#528)", question: consentQ, details: { response: { answers: { [consentQ.id]: { selected: "" } } } }, expected: "waiting" },
  { name: "consent × missing answer → waiting", question: consentQ, details: { response: { answers: {} } }, expected: "waiting" },
  { name: "consent × missing response → waiting", question: consentQ, details: {}, expected: "waiting" },
  { name: "consent × notes-only → answered (a real user utterance)", question: consentQ, details: { response: { answers: { [consentQ.id]: { notes: "neither — keep it simple" } } } }, expected: "answered" },
  { name: "consent × cancelled → cancelled", question: consentQ, details: { cancelled: true, response: null }, expected: "cancelled" },
  { name: "consent × timed_out → timeout (#852)", question: consentQ, details: { cancelled: true, timed_out: true, response: null }, expected: "timeout" },
];

for (const row of POLICY_TABLE) {
  test(`policy table: ${row.name}`, () => {
    assert.equal(evaluateAnswer({ question: row.question, details: row.details }), row.expected);
  });
}

// ── Round evaluation ────────────────────────────────────────────────────────

test("evaluateAskUserQuestionsRound: most blocking outcome wins", () => {
  const details = {
    response: {
      answers: {
        [consentQ.id]: { selected: "Option A (Recommended)" },
        second: { selected: "" },
      },
    },
  };
  assert.equal(
    evaluateAskUserQuestionsRound([consentQ, { id: "second", options: CONSENT_OPTIONS }], details),
    "waiting",
  );
  assert.equal(evaluateAskUserQuestionsRound([consentQ], { cancelled: true }), "cancelled");
  assert.equal(
    evaluateAskUserQuestionsRound([consentQ], {
      response: { answers: { [consentQ.id]: { selected: "Option A (Recommended)" } } },
    }),
    "answered",
  );
  // Empty round with no response is a no-op for callers.
  assert.equal(evaluateAskUserQuestionsRound([], {}), "answered");
});

// ── #852: host elicitation timeout → "timeout" round outcome ────────────────

test("#852: timed_out round → timeout (does NOT become waiting/answered)", () => {
  // A timeout must not be laundered into "waiting" (which tells the model to
  // re-ask — that just hits the same timeout again) or "answered".
  assert.equal(
    evaluateAskUserQuestionsRound([consentQ], { cancelled: true, timed_out: true, response: null }),
    "timeout",
  );
  assert.equal(
    evaluateAskUserQuestionsRound([gateQ], { cancelled: true, timed_out: true, response: null }),
    "timeout",
  );
});

test("#852: timeout wins over answered in a mixed round (most blocking)", () => {
  // One answered question + one timed_out question → the whole round is timeout.
  const details = {
    timed_out: true,
    cancelled: true,
    response: null,
  };
  assert.equal(
    evaluateAskUserQuestionsRound(
      [consentQ, { id: "other", options: CONSENT_OPTIONS }],
      // The timed_out flag is round-level, so even if one question "answered"
      // the timeout on the round dominates.
      details,
    ),
    "timeout",
  );
});

test("#852: cancelled still beats timeout when both flags absent on the round", () => {
  // Round-level cancelled without timed_out stays cancelled (deliberate user
  // dismissal is a stronger signal than a host timeout).
  assert.equal(
    evaluateAskUserQuestionsRound([consentQ], { cancelled: true, response: null }),
    "cancelled",
  );
});

// ── Regression: #528 empty selected on a consent question never answers ─────

test("#528: empty selected on a NON-gate question is waiting, not answered", () => {
  const outcome = evaluateAskUserQuestionsRound(
    [{ id: "scope_check", options: CONSENT_OPTIONS }],
    { response: { answers: { scope_check: { selected: "" } } } },
  );
  assert.equal(outcome, "waiting");
  const message = formatUnansweredConsentQuestionMessage([{ id: "scope_check" }]);
  assert.match(message, /scope_check/);
  assert.match(message, /not consent/i);
});

// ── Regression: #682 pause promotion outside the old unit-type allowlist ────

test("#682: consent question in a non-allowlisted unit type pauses", () => {
  const messages = [assistantMessage("The slice is staged. Ready to proceed with the merge?")];
  assert.equal(shouldPauseForQuestion("execute-task", messages), true);
});

test("#682: consent question in interactive mode (no unit type) pauses", () => {
  const messages = [assistantMessage("Does this capture your intent correctly?")];
  assert.equal(shouldPauseForQuestion(undefined, messages), true);
});

test("#682: cancellation marker pauses regardless of unit type", () => {
  const messages = [assistantMessage("ask_user_questions was cancelled before receiving a response")];
  assert.equal(shouldPauseForQuestion(undefined, messages), true);
  assert.equal(shouldPauseForQuestion("execute-task", messages), true);
});

test("shouldPauseForQuestion: informational prose never pauses", () => {
  const messages = [assistantMessage("All tests pass. Moving on to the next task.")];
  assert.equal(shouldPauseForQuestion(undefined, messages), false);
  assert.equal(shouldPauseForQuestion("discuss-project", messages), false);
});

test("shouldPauseForQuestion: plain non-approval question does not pause", () => {
  // Generic questions (no approval/consent language) stay informational —
  // matches the historical contract in deep-project-auto-loop tests.
  const messages = [assistantMessage("Which file did you mean?")];
  assert.equal(shouldPauseForQuestion("discuss-project", messages), false);
});

test("shouldPauseForQuestion: explicit waiting-for-approval phrase pauses without a question mark", () => {
  // The streaming pre-filter (no "?" → bail) must not skip the explicit
  // wait-phrase boundary, which carries no question mark.
  const messages = [assistantMessage("I am waiting for your approval before writing the file.")];
  assert.equal(shouldPauseForQuestion(undefined, messages), true);
});

// ── Message-text extraction (merged from user-input-boundary tests) ─────────

test("lastAssistantText extracts the latest assistant text block content", () => {
  assert.equal(
    lastAssistantText([
      { role: "assistant", content: "Older message" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First line" },
          { type: "text", text: "Second line" },
        ],
      },
    ]),
    "First line\nSecond line",
  );
  assert.equal(lastAssistantText(null), "");
});

test("lastAssistantText includes thinking blocks so rate-limit notices are not dropped", () => {
  // Turn with only a thinking block (no text block) — must not return ""
  const result = lastAssistantText([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "You've hit your limit · resets in 2h" },
      ],
    },
  ]);
  assert.ok(result.includes("You've hit your limit"), `expected rate-limit text, got: ${JSON.stringify(result)}`);
});

// ── Awaiting-input boundaries (merged from user-input-boundary tests) ───────

test("isAwaitingUserInput does not trigger on thinking-block question marks", () => {
  // A thinking block with a question mark must NOT pause auto-mode —
  // it's internal reasoning, not a user-visible prompt.
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Should I skip research? Let me check the config." },
      ],
    },
  ];
  assert.equal(isAwaitingUserInput(messages), false);
  assert.equal(shouldPauseForQuestion("discuss-project", messages), false);
});

test("isAwaitingUserInput does not trigger on thinking-block approval phrases", () => {
  // A thinking block with approval phrases must NOT pause auto-mode.
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The user confirmed and approved the plan. Should I proceed?" },
      ],
    },
  ];
  assert.equal(isAwaitingUserInput(messages), false);
  assert.equal(shouldPauseForQuestion("discuss-requirements", messages), false);
});

test("isAwaitingUserInput treats plain-text next steps menus as waiting for the user (#454)", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        "Next steps:",
        "1. Walk through the runtime placement check above.",
        "2. Build a release once you're satisfied.",
        "3. Other.",
      ].join("\n"),
    },
  ];
  assert.equal(isAwaitingUserInput(messages), true);
});

test("isAwaitingUserInput still triggers on text-block question marks when thinking is also present", () => {
  // When thinking + text are both present and the text asks a question, it should still pause.
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Internal reasoning without questions." },
        { type: "text", text: "Does this look correct?" },
      ],
    },
  ];
  assert.equal(isAwaitingUserInput(messages), true);
});

// ── In-flight ask_user_questions detection (merged from user-input-boundary) ─

test("messageHasPendingAskUserQuestionsTool detects in-flight structured question tools", () => {
  // state: "running" with no externalResult → still in-flight
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "text", text: "Which direction?" },
        { type: "toolCall", name: "mcp__gsd-workflow__ask_user_questions", state: "running" },
      ],
    }),
    true,
  );

  // no state, no externalResult — streaming block that hasn't completed yet
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "toolCall", name: "ask_user_questions" },
      ],
    }),
    true,
  );

  // state: "completed" — legacy state-based completion
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "toolCall", name: "ask_user_questions", state: "completed" },
      ],
    }),
    false,
  );

  // externalResult present — Claude Code signals completion via externalResult, not state
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "toolCall", name: "ask_user_questions", externalResult: { content: [], isError: false } },
      ],
    }),
    false,
  );
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "ask_user_questions",
          externalResult: { content: [{ type: "text", text: "answer" }], isError: false },
        },
      ],
    }),
    false,
  );

  // serverToolUse shape (claude-code-cli MCP path) — no externalResult → in-flight
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "serverToolUse", name: "mcp__gsd-workflow__ask_user_questions" },
      ],
    }),
    true,
  );
  // serverToolUse shape — externalResult present → completed
  assert.equal(
    messageHasPendingAskUserQuestionsTool({
      role: "assistant",
      content: [
        { type: "serverToolUse", name: "ask_user_questions", externalResult: { content: [], isError: false } },
      ],
    }),
    false,
  );
});
