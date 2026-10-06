import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import { getPendingGate, clearDiscussionFlowState } from "../bootstrap/write-gate.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-ask-shape-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function collectHandlers(): Map<string, Array<Handler>> {
  const handlers = new Map<string, Array<Handler>>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  registerHooks(pi, []);
  return handlers;
}

async function fire(handlers: Map<string, Array<Handler>>, event: string, payload: any): Promise<void> {
  for (const handler of handlers.get(event) ?? []) {
    await handler(payload);
  }
}

const GATE_QUESTION_ID = "depth_verification_M001_confirm";
const GATE_QUESTIONS = [
  {
    id: GATE_QUESTION_ID,
    question: "Do you agree?",
    options: [
      { label: "Yes, you got it (Recommended)" },
      { label: "Needs adjustment" },
    ],
  },
];

test("ask_user_questions with a non-array questions arg must not arm a gate or throw (#2530)", async (t) => {
  const dir = makeTempDir("non-array");
  const originalCwd = process.cwd();
  process.chdir(dir);
  clearDiscussionFlowState(dir);

  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = collectHandlers();

  // External-engine/MCP relays may pass arguments as a JSON string or object.
  const shapes: Array<[string, unknown]> = [
    ["JSON string", JSON.stringify(GATE_QUESTIONS)],
    ["object", { 0: GATE_QUESTIONS[0] }],
    ["undefined", undefined],
  ];
  for (const [label, questions] of shapes) {
    clearDiscussionFlowState(dir);
    await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions } });
    await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions } });
    assert.equal(getPendingGate(), null, `${label} questions must not arm a gate`);
  }

  // Normal array shape still arms the gate.
  clearDiscussionFlowState(dir);
  await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions: GATE_QUESTIONS } });
  await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions: GATE_QUESTIONS } });
  assert.equal(getPendingGate(), GATE_QUESTION_ID, "array questions must still arm the gate");
});

test("tool_result with a non-array questions input degrades to no gate match (#2530)", async (t) => {
  const dir = makeTempDir("result-non-array");
  const originalCwd = process.cwd();
  process.chdir(dir);
  clearDiscussionFlowState(dir);

  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = collectHandlers();

  await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions: GATE_QUESTIONS } });
  await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions: GATE_QUESTIONS } });
  assert.equal(getPendingGate(), GATE_QUESTION_ID, "precondition: gate armed");

  // A relayed result whose input.questions is a JSON string must not throw and
  // must not verify the armed gate — it degrades to "no gate question found"
  // and the gate stays pending (fail-closed).
  await fire(handlers, "tool_result", {
    toolName: "ask_user_questions",
    input: { questions: JSON.stringify(GATE_QUESTIONS) },
    details: {
      response: {
        answers: {
          [GATE_QUESTION_ID]: { selected: "Yes, you got it (Recommended)" },
        },
      },
    },
  });

  assert.equal(getPendingGate(), GATE_QUESTION_ID, "malformed relayed result must not verify the armed gate");
});

test("tool_result falls back to details.questions when input.questions is malformed (#2530)", async (t) => {
  const dir = makeTempDir("details-fallback");
  const originalCwd = process.cwd();
  process.chdir(dir);
  clearDiscussionFlowState(dir);

  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = collectHandlers();

  await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions: GATE_QUESTIONS } });
  await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions: GATE_QUESTIONS } });
  assert.equal(getPendingGate(), GATE_QUESTION_ID, "precondition: gate armed");

  // Malformed input.questions is treated as absent, so a valid details.questions
  // round with a confirming answer still verifies the gate.
  await fire(handlers, "tool_result", {
    toolName: "ask_user_questions",
    input: { questions: JSON.stringify(GATE_QUESTIONS) },
    details: {
      questions: GATE_QUESTIONS,
      response: {
        answers: {
          [GATE_QUESTION_ID]: { selected: "Yes, you got it (Recommended)" },
        },
      },
    },
  });

  assert.equal(getPendingGate(), null, "valid details.questions round must verify the armed gate");
});

test("tool_result with malformed input.questions and malformed details.questions must not throw (#2530)", async (t) => {
  const dir = makeTempDir("both-malformed");
  const originalCwd = process.cwd();
  process.chdir(dir);
  clearDiscussionFlowState(dir);

  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = collectHandlers();

  await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions: GATE_QUESTIONS } });
  await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions: GATE_QUESTIONS } });
  assert.equal(getPendingGate(), GATE_QUESTION_ID, "precondition: gate armed");

  await fire(handlers, "tool_result", {
    toolName: "ask_user_questions",
    input: { questions: "not-an-array" },
    details: { questions: { 0: GATE_QUESTIONS[0] } },
  });

  assert.equal(getPendingGate(), GATE_QUESTION_ID, "no usable question round must leave the gate pending");
});

test("tool_result input.questions keeps precedence over details.questions even when empty (#2530)", async (t) => {
  const dir = makeTempDir("input-precedence");
  const originalCwd = process.cwd();
  process.chdir(dir);
  clearDiscussionFlowState(dir);

  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = collectHandlers();

  await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions: GATE_QUESTIONS } });
  await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions: GATE_QUESTIONS } });
  assert.equal(getPendingGate(), GATE_QUESTION_ID, "precondition: gate armed");

  // An empty input array is a valid array and wins over details, so the
  // confirming answer in details must NOT verify the gate.
  await fire(handlers, "tool_result", {
    toolName: "ask_user_questions",
    input: { questions: [] },
    details: {
      questions: GATE_QUESTIONS,
      response: {
        answers: {
          [GATE_QUESTION_ID]: { selected: "Yes, you got it (Recommended)" },
        },
      },
    },
  });

  assert.equal(getPendingGate(), GATE_QUESTION_ID, "empty input array must keep precedence over details.questions");
});

test("tool_result resolves questions from result.structuredContent when details are missing (#2530)", async (t) => {
  const dir = makeTempDir("structured-fallback");
  const originalCwd = process.cwd();
  process.chdir(dir);
  clearDiscussionFlowState(dir);

  t.after(() => {
    try {
      clearDiscussionFlowState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = collectHandlers();

  await fire(handlers, "tool_call", { toolName: "ask_user_questions", input: { questions: GATE_QUESTIONS } });
  await fire(handlers, "tool_execution_start", { toolName: "ask_user_questions", args: { questions: GATE_QUESTIONS } });
  assert.equal(getPendingGate(), GATE_QUESTION_ID, "precondition: gate armed");

  // MCP relays carry the round through result.structuredContent; a malformed
  // input.questions must not break that fallback.
  await fire(handlers, "tool_result", {
    toolName: "ask_user_questions",
    input: { questions: JSON.stringify(GATE_QUESTIONS) },
    result: {
      structuredContent: {
        questions: GATE_QUESTIONS,
        response: {
          answers: {
            [GATE_QUESTION_ID]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    },
  });

  assert.equal(getPendingGate(), null, "structuredContent fallback must still verify the armed gate");
});
