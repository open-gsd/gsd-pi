import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  clearPendingAutoStart,
  setPendingAutoStart,
} from "../guided-flow.ts";
import { closeDatabase, getMilestone } from "../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import {
  getPendingGate,
  loadWriteGateSnapshot,
  markApprovalGateVerified,
  markDepthVerified,
  resetWriteGateState,
  setPendingGate,
  shouldBlockContextArtifactSave,
  shouldBlockContextWrite,
} from "../bootstrap/write-gate.ts";
import { classifyCommand } from "../safety/destructive-guard.ts";
import { toRoundResultResponse } from "../../remote-questions/manager.ts";
import {
  markInteractiveElicitationStart,
  markInteractiveElicitationEnd,
  clearInFlightTools,
} from "../auto-tool-tracking.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-depth-gate-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function armDepthGate(
  handlers: Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>,
  toolName: string,
  questions: unknown[],
): Promise<void> {
  const input = { questions };
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName, input });
  }
  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({ toolName, args: input });
  }
}

test("destructive guard classifies infrastructure mutation commands", () => {
  assert.deepEqual(classifyCommand("terraform destroy -auto-approve").labels, ["IaC apply/destroy"]);
  assert.deepEqual(classifyCommand("terragrunt apply").labels, ["IaC apply/destroy"]);
  assert.deepEqual(classifyCommand("aws s3 delete-bucket --bucket example").labels, ["AWS mutation"]);
  assert.deepEqual(classifyCommand("kubectl delete namespace prod").labels, ["kubectl mutation"]);
});

test("register-hooks hard-blocks destructive bash commands outside auto-mode", async () => {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  let block: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "terraform apply -auto-approve" },
    });
    if (result?.block) block = result;
  }

  assert.equal(block?.block, true);
  assert.match(block?.reason ?? "", /HARD BLOCK: destructive Bash command requires explicit human confirmation/);
  assert.match(block?.reason ?? "", /IaC apply\/destroy/);
});

test("register-hooks keeps depth-gate reason model-facing and adds displayReason", async (t) => {
  const dir = makeTempDir("display-reason");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  let block: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "write",
      input: {
        path: join(dir, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        content: "# M001 Context\n",
      },
    });
    if (result?.block) block = result;
  }

  assert.equal(block?.block, true);
  assert.match(block?.reason ?? "", /HARD BLOCK: Cannot write to milestone CONTEXT\.md/);
  assert.match(block?.reason ?? "", /ask_user_questions/);
  assert.equal(block?.displayReason, "Depth check required before writing milestone context.");
});

test("register-hooks unlocks milestone depth verification from question id without guided-flow state (#4047)", async (t) => {
  const dir = makeTempDir("manual");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<void> | void>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  const toolResultHandlers = handlers.get("tool_result");
  assert.ok(toolResultHandlers?.length, "tool_result handler should be registered");

  await armDepthGate(handlers, "ask_user_questions", questions);

  assert.equal(getPendingGate(), questionId, "gate should be set even without guided-flow state");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    true,
    "milestone context should still be blocked before confirmation",
  );

  for (const handler of toolResultHandlers ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    });
  }

  assert.equal(getPendingGate(), null, "confirming the depth question should clear the pending gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "question-id milestone inference should unlock the matching milestone context write",
  );
});

test("register-hooks canonicalizes lower-case milestone ids in depth-verification question ids", async (t) => {
  const dir = makeTempDir("lowercase-mid");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<void> | void>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_m001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  await armDepthGate(handlers, "ask_user_questions", questions);
  assert.equal(getPendingGate(), questionId);

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    });
  }

  assert.equal(getPendingGate(), null, "confirming lower-case m001 gate should clear pending state");
  assert.deepEqual(
    loadWriteGateSnapshot(dir).verifiedDepthMilestones,
    ["M001"],
    "verified milestone id should be stored canonically",
  );
  assert.equal(
    shouldBlockContextWrite(
      "write",
      ".gsd/milestones/M001/M001-CONTEXT.md",
      null,
      false,
      dir,
    ).block,
    false,
    "lower-case question id should unlock the matching upper-case CONTEXT.md path",
  );
});

test("register-hooks persists first structured question round for new milestone re-entry", async (t) => {
  const dir = makeTempDir("question-draft");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  clearPendingAutoStart(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
      clearPendingAutoStart(dir);
      closeDatabase();
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<void> | void>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  registerHooks(pi, []);
  setPendingAutoStart(dir, {
    basePath: dir,
    milestoneId: "M004",
    ctx,
    pi: { sendMessage: () => undefined } as any,
  });

  const questions = [
    {
      id: "m004_shape",
      header: "M004 Shape",
      question: "What are you picturing for M004?",
      options: [
        { label: "Planning metadata (Recommended)", description: "Plan the next metadata layer." },
        { label: "Find and organize", description: "Improve searching and organizing." },
      ],
    },
    {
      id: "boundary",
      header: "Boundary",
      question: "Which boundary should I plan around?",
      options: [
        { label: "No new dependencies (Recommended)", description: "Keep implementation vanilla." },
        { label: "Browser APIs OK", description: "Use browser-native capabilities." },
      ],
    },
  ];

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            m004_shape: { selected: "Planning metadata (Recommended)" },
            boundary: { selected: "No new dependencies (Recommended)" },
          },
        },
      },
    }, ctx);
  }

  // Flat-phase: ensureMilestoneShell creates phases/04-new-milestone-m004/ for M004
  const milestoneDir = join(dir, ".gsd", "phases", "04-new-milestone-m004");
  const draftPath = join(milestoneDir, "04-CONTEXT-DRAFT.md");
  const discussionPath = join(milestoneDir, "04-DISCUSSION.md");

  assert.equal(existsSync(draftPath), true, "first answer round should create a resumable context draft");
  assert.equal(existsSync(discussionPath), true, "first answer round should create a discussion log");

  const draft = readFileSync(draftPath, "utf-8");
  assert.match(draft, /What are you picturing for M004\?/);
  assert.match(draft, /Planning metadata \(Recommended\)/);
  assert.match(draft, /No new dependencies \(Recommended\)/);

  const row = getMilestone("M004");
  assert.equal(row?.status, "queued", "new milestone shell should be registered in the DB");

  invalidateStateCache();
  const state = await deriveState(dir);
  assert.equal(state.activeMilestone?.id, "M004");
  assert.equal(state.phase, "needs-discussion");
});

test("register-hooks clears depth gate when remote (Telegram/Slack/Discord) answer is normalized (#4406)", async (t) => {
  const dir = makeTempDir("remote");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<void> | void>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M002_confirm";
  const questions = [
    {
      id: questionId,
      question: "Do you agree?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  await armDepthGate(handlers, "ask_user_questions", questions);
  assert.equal(getPendingGate(), questionId);

  // Simulate the normalized response the remote manager now emits:
  // a Telegram button press returns a RemoteAnswer that is fed through
  // toRoundResultResponse before reaching details.response.
  const remoteAnswer = {
    answers: {
      [questionId]: { answers: ["Yes, you got it (Recommended)"] },
    },
  };
  const normalized = toRoundResultResponse(remoteAnswer);

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { response: normalized },
    });
  }

  assert.equal(getPendingGate(), null, "normalized remote answer must clear the gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M002").block,
    false,
    "remote confirmation must unlock the matching milestone context write",
  );
});

test("register-hooks returns hard blocker when depth question is cancelled", async (t) => {
  const dir = makeTempDir("cancelled");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M003_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture this correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Needs adjustment" },
      ],
    },
  ];

  await armDepthGate(handlers, "ask_user_questions", questions);
  assert.equal(getPendingGate(), questionId);

  let patch: any;
  for (const handler of handlers.get("tool_result") ?? []) {
    const result = await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null },
    });
    if (result) patch = result;
  }

  assert.equal(getPendingGate(), questionId, "cancelled question must leave gate pending");
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /Waiting for depth confirmation on gate "depth_verification_M003_confirm"/,
  );
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /Do not infer approval from earlier or prior messages/,
  );
  assert.match(
    patch?.content?.[0]?.text ?? "",
    /Re-call ask_user_questions with the same gate question id/,
    "must instruct the agent to re-ask via ask_user_questions",
  );
  assert.doesNotMatch(
    patch?.content?.[0]?.text ?? "",
    /confirm in plain chat, then stop/,
    "must not direct the agent down the prior dead-end plain-chat-and-stop path",
  );
});

test("register-hooks clears deferred approval gate after depth confirmation (headless e2e regression)", async (t) => {
  const dir = makeTempDir("deferred-clear");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Proceed with this headless milestone plan?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Not quite" },
      ],
    },
  ];

  await armDepthGate(handlers, "ask_user_questions", questions);

  // message_update can re-arm defer after execution_start cleared it.
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolName: "ask_user_questions", input: { questions } });
  }

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    });
  }

  let contextBlock: { block?: boolean; reason?: string } | undefined;
  for (const handler of handlers.get("tool_call") ?? []) {
    contextBlock = await handler({
      toolName: "gsd_summary_save",
      input: {
        milestone_id: "M001",
        artifact_type: "CONTEXT",
        content: "# M001 Context\n",
      },
    });
  }

  assert.notEqual(
    contextBlock?.block,
    true,
    "context save must not stay blocked by deferred approval gate after confirmation",
  );
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "depth verification should unlock milestone context writes",
  );
});

test("register-hooks recovers from a cancelled depth question via re-asked ask_user_questions (milestone-hang regression)", async (t) => {
  const dir = makeTempDir("recovery");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_M001_confirm";
  const questions = [
    {
      id: questionId,
      question: "Did I capture the project correctly?",
      options: [
        { label: "Yes, you got it (Recommended)" },
        { label: "Not quite — let me clarify" },
      ],
    },
  ];

  // 1. Initial ask sets the gate.
  await armDepthGate(handlers, "ask_user_questions", questions);
  assert.equal(getPendingGate(), questionId, "initial ask must set the gate");

  // 2. User cancels (simulates the trap from the screenshot: question never
  //    answered through the structured channel). Gate must stay pending.
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null },
    });
  }
  assert.equal(getPendingGate(), questionId, "cancelled response must leave gate pending");

  // 3. Recovery path: immediately re-call ask_user_questions with the same
  //    gate id and identical input. This must not be blocked by the strict
  //    duplicate-call loop guard, because the hard-block instruction above
  //    tells the agent to do exactly this and not to interleave other tools.
  const reaskBlocks: any[] = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({ toolName: "ask_user_questions", input: { questions } });
    if (result?.block) reaskBlocks.push(result);
  }
  assert.equal(
    reaskBlocks.length,
    0,
    "immediate identical re-ask must not be blocked by the tool-call loop guard",
  );

  // 4. The re-asked question receives a confirming response, which clears the
  //    gate and unlocks the milestone context save.
  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({ toolName: "ask_user_questions", args: { questions } });
  }
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        response: {
          answers: {
            [questionId]: { selected: "Yes, you got it (Recommended)" },
          },
        },
      },
    });
  }

  assert.equal(getPendingGate(), null, "confirming re-ask must clear the gate");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001").block,
    false,
    "context save must unlock after recovery",
  );
});

test("register-hooks gates MCP ask_user_questions cancellation before requirement saves", async (t) => {
  const dir = makeTempDir("mcp-cancelled");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);

  t.after(() => {
    try {
      resetWriteGateState(dir);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  const questionId = "depth_verification_requirements_confirm";
  const questions = [
    {
      id: questionId,
      question: "Are these the right requirements at the right scope?",
      options: [
        { label: "Yes, ship it (Recommended)" },
        { label: "Not quite — let me adjust" },
      ],
    },
  ];

  const askBlocks: any[] = [];
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "mcp__gsd-workflow__ask_user_questions",
      input: { questions },
    });
    if (result) askBlocks.push(result);
  }

  assert.equal(getPendingGate(), null, "MCP ask_user_questions should defer the gate until execution starts");
  assert.equal(
    askBlocks.some((result) => result?.block === true),
    false,
    "the gate-setting MCP ask_user_questions call itself should be allowed",
  );

  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({
      toolName: "mcp__gsd-workflow__ask_user_questions",
      args: { questions },
    });
  }
  assert.equal(getPendingGate(), questionId, "execution start should activate the pending gate");

  let hardBlock: any;
  for (const handler of handlers.get("tool_result") ?? []) {
    const result = await handler({
      toolName: "mcp__gsd-workflow__ask_user_questions",
      input: { questions },
      details: { cancelled: true, response: null },
    });
    if (result) hardBlock = result;
  }

  assert.equal(getPendingGate(), questionId, "cancelled MCP question must leave gate pending");
  assert.match(
    hardBlock?.content?.[0]?.text ?? "",
    /Waiting for depth confirmation on gate "depth_verification_requirements_confirm"/,
  );

  let toolSearchBlock: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "ToolSearch",
      input: { query: "select:mcp__gsd-workflow__gsd_requirement_save", max_results: 2 },
    });
    if (result?.block) toolSearchBlock = result;
  }
  assert.equal(toolSearchBlock?.block, true, "ToolSearch must not bury a pending approval question");

  let requirementBlock: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolName: "mcp__gsd-workflow__gsd_requirement_save",
      input: {
        class: "functional",
        description: "User can add tasks to the todo list",
        why: "Primary product value",
        source: "primary-user-loop",
      },
    });
    if (result?.block) requirementBlock = result;
  }

  assert.equal(requirementBlock?.block, true, "requirement save must be blocked while gate is pending");
  assert.match(requirementBlock?.reason ?? "", /has not been confirmed/);
});

// ─── Foreground self-cancel regression (#cc-elicitation-self-cancel) ───
// Product-visible symptom: under claude-code-cli + gsd-MCP, ask_user_questions
// is routed as an SDK elicitation (the human boundary). The message_update hook
// would arm the approval-gate pause and emit the "waiting for your approval -
// pausing" notice, tearing down that elicitation and looping a re-ask. The fix
// makes message_update bail while an interactive elicitation is in flight, while
// still pausing for prose-only approvals (native-TUI provider, where the marker
// is always false). This drives the real registered hook end-to-end.
test("register-hooks message_update does NOT pause while an interactive elicitation is the human boundary, but still pauses otherwise", async (t) => {
  const dir = makeTempDir("elicitation-pause-guard");
  const originalCwd = process.cwd();
  process.chdir(dir);
  resetWriteGateState(dir);
  clearPendingAutoStart(dir);
  clearInFlightTools();

  t.after(() => {
    try {
      resetWriteGateState(dir);
      clearPendingAutoStart(dir);
      clearInFlightTools();
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    cwd: dir,
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
  } as any;

  registerHooks(pi, []);

  // A discuss-milestone is the active unit, so the approval text would normally
  // arm the pause/notice path.
  setPendingAutoStart(dir, {
    basePath: dir,
    milestoneId: "M001",
    ctx,
    pi: { sendMessage: () => undefined } as any,
  });

  // The model's plain-text approval question — identical in both phases.
  const approvalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Here is the milestone plan.\n\nDid I capture the project correctly?" },
    ],
  };

  const fireMessageUpdate = async () => {
    for (const handler of handlers.get("message_update") ?? []) {
      await handler({ message: approvalMessage }, ctx);
    }
  };

  // Phase 1 — FIX: an interactive elicitation is in flight (claude-code-cli
  // foreground). The pause/notice MUST be suppressed.
  markInteractiveElicitationStart();
  await fireMessageUpdate();
  assert.equal(
    notices.some((n) => /waiting for your approval - pausing/.test(n.text)),
    false,
    "must NOT emit the approval-pause notice while the elicitation is the human boundary",
  );
  markInteractiveElicitationEnd();

  // Phase 2 — control: no elicitation in flight (native-TUI provider or a
  // prose-only approval). The same message MUST still pause.
  notices.length = 0;
  await fireMessageUpdate();
  assert.equal(
    notices.some((n) => /discuss-milestone M001 is waiting for your approval - pausing/.test(n.text)),
    true,
    "prose-only approval with no elicitation in flight must still arm the pause notice",
  );
});

test("register-hooks agent_end does not re-arm deferred gate after workflow MCP verified write-gate on disk", async (t) => {
  const dir = makeTempDir("mcp-disk-sync");
  const originalCwd = process.cwd();
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  process.chdir(dir);
  resetWriteGateState(dir);
  clearPendingAutoStart(dir);
  process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";

  const gateId = "depth_verification_M005_confirm";
  const statePath = join(dir, ".gsd", "runtime", "write-gate-state.json");

  t.after(() => {
    try {
      resetWriteGateState(dir);
      clearPendingAutoStart(dir);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
      } else {
        process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
      }
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  const ctx = {
    cwd: dir,
    ui: { notify: () => undefined },
  } as any;

  registerHooks(pi, []);

  setPendingAutoStart(dir, {
    basePath: dir,
    milestoneId: "M005",
    ctx,
    pi: { sendMessage: () => undefined } as any,
  });

  const approvalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Did I capture the depth right?" },
    ],
  };

  for (const handler of handlers.get("message_update") ?? []) {
    await handler({ message: approvalMessage }, ctx);
  }

  setPendingGate(gateId, dir);
  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    verifiedDepthMilestones: ["M005"],
    verifiedApprovalGates: [gateId],
    activeQueuePhase: false,
    pendingGateId: null,
  }, null, 2), "utf-8");

  for (const handler of handlers.get("agent_end") ?? []) {
    await handler({ messages: [] }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "agent_end must not re-arm a gate the MCP subprocess already verified");
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M005", null, dir).block,
    false,
    "verified milestone context writes must stay unlocked after agent_end",
  );
  assert.deepEqual(loadWriteGateSnapshot(dir), {
    verifiedDepthMilestones: ["M005"],
    verifiedApprovalGates: [gateId],
    activeQueuePhase: false,
    pendingGateId: null,
  });
});

test("register-hooks message_update uses in-memory write-gate snapshot instead of disk reconcile", async (t) => {
  const dir = makeTempDir("message-update-memory-snapshot");
  const originalCwd = process.cwd();
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  process.chdir(dir);
  process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";
  resetWriteGateState(dir);
  clearPendingAutoStart(dir);

  const gateId = "depth_verification_M012_confirm";
  const statePath = join(dir, ".gsd", "runtime", "write-gate-state.json");

  t.after(() => {
    try {
      resetWriteGateState(dir);
      clearPendingAutoStart(dir);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
      } else {
        process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
      }
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    cwd: dir,
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
  } as any;

  registerHooks(pi, []);
  setPendingAutoStart(dir, {
    basePath: dir,
    milestoneId: "M012",
    ctx,
    pi: { sendMessage: () => undefined } as any,
  });

  mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    verifiedDepthMilestones: ["M012"],
    verifiedApprovalGates: [gateId],
    activeQueuePhase: false,
    pendingGateId: null,
  }, null, 2), "utf-8");

  const approvalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Here is the milestone plan.\n\nDid I capture the project correctly?" },
    ],
  };

  for (const handler of handlers.get("message_update") ?? []) {
    await handler({ message: approvalMessage }, ctx);
  }

  assert.equal(
    notices.some((n) => /discuss-milestone M012 is waiting for your approval - pausing/.test(n.text)),
    true,
    "streaming hook must not suppress the pause from a disk-only verification",
  );
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M012", null, dir).block,
    true,
    "streaming hook must not reconcile disk-only verification into the in-memory snapshot",
  );

  for (const handler of handlers.get("agent_end") ?? []) {
    await handler({ messages: [] }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "agent_end still reconciles disk and suppresses durable re-arm");
});

// ── External-engine post-hoc gate replay (write-gate two-process sync) ──────
// On claude-code-cli, pi ingests the SDK turn's tool blocks after the workflow
// MCP child already executed them. The depth gate can therefore arrive at
// tool_execution_start AFTER the child verified it and allowed the CONTEXT
// save; re-arming then wipes the verification and permanently blocks the
// discuss→auto handoff.

function makeHookHarness(): {
  handlers: Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>;
  pi: any;
} {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  return { handlers, pi };
}

test("tool_execution_start does not re-arm a depth gate the MCP child already verified", async (t) => {
  const dir = makeTempDir("posthoc-no-rearm");
  resetWriteGateState(dir);
  t.after(() => {
    resetWriteGateState(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  // The child verified the gate and allowed the CONTEXT save before the host
  // ever saw the tool block.
  markApprovalGateVerified("depth_verification_M002_confirm", dir);
  markDepthVerified("M002", dir);

  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({
      toolCallId: "t-depth",
      toolName: "mcp__gsd-workflow__ask_user_questions",
      args: { questions: [{ id: "depth_verification_M002_confirm" }] },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "post-hoc replay must not re-arm a verified gate");
  const snapshot = loadWriteGateSnapshot(dir);
  assert.ok(
    snapshot.verifiedDepthMilestones.includes("M002"),
    "re-arm wipes verifiedDepthMilestones — the verification must survive the replay",
  );
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M002", null, dir).block,
    false,
    "context saves must stay unlocked after the replayed tool_execution_start",
  );
});

test("tool_execution_start still arms an unverified depth gate", async (t) => {
  const dir = makeTempDir("live-arm");
  resetWriteGateState(dir);
  t.after(() => {
    resetWriteGateState(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({
      toolCallId: "t-depth",
      toolName: "ask_user_questions",
      args: { questions: [{ id: "depth_verification_M002_confirm" }] },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), "depth_verification_M002_confirm");
});

test("tool_result verifies the gate from result.structuredContent when event.details is missing", async (t) => {
  const dir = makeTempDir("structured-fallback");
  resetWriteGateState(dir);
  t.after(() => {
    resetWriteGateState(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  setPendingGate("depth_verification_M002_confirm", dir);

  const questions = [{
    id: "depth_verification_M002_confirm",
    options: [
      { label: "Yes, you got it (Recommended)" },
      { label: "Not quite — let me clarify" },
    ],
  }];
  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolCallId: "t-depth",
      toolName: "mcp__gsd-workflow__ask_user_questions",
      input: { questions },
      // External MCP relay: no pi-native details, structured payload on result.
      result: {
        content: [{ type: "text", text: "answered" }],
        structuredContent: {
          questions,
          response: {
            answers: {
              depth_verification_M002_confirm: { selected: "Yes, you got it (Recommended)", notes: "" },
            },
          },
          cancelled: false,
        },
      },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "structured fallback must clear the pending gate");
  assert.ok(loadWriteGateSnapshot(dir).verifiedDepthMilestones.includes("M002"));
});

test("tool_result normalizes provider answers shape before verifying a depth gate (#1894)", async (t) => {
  const dir = makeTempDir("provider-answers");
  resetWriteGateState(dir);
  t.after(() => {
    resetWriteGateState(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;
  const questionId = "depth_verification_M001-sdflkr";
  const questions = [{
    id: questionId,
    options: [
      { label: "Confirm M001 (Recommended)" },
      { label: "Not quite — let me clarify" },
    ],
  }];

  setPendingGate(questionId, dir);

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolCallId: "t-depth",
      toolName: "ask_user_questions",
      input: { questions },
      details: {
        answers: {
          [questionId]: { answers: ["Confirm M001 (Recommended)"] },
        },
      },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "provider-shaped confirmation must clear the pending gate");
  assert.ok(
    loadWriteGateSnapshot(dir).verifiedDepthMilestones.includes("M001-sdflkr"),
    "provider-shaped confirmation must persist milestone depth verification",
  );
  assert.equal(
    shouldBlockContextArtifactSave("CONTEXT", "M001-sdflkr", null, dir).block,
    false,
    "provider-shaped confirmation must unlock the matching milestone context",
  );

  let contextBlock: { block?: boolean } | undefined;
  for (const handler of handlers.get("tool_call") ?? []) {
    contextBlock = await handler({
      toolName: "gsd_summary_save",
      input: {
        milestone_id: "M001-sdflkr",
        artifact_type: "CONTEXT",
        content: "# M001 Context\n",
      },
    }, ctx);
  }
  assert.notEqual(contextBlock?.block, true, "the subsequent milestone CONTEXT save must be permitted");
});

test("tool_result without details or structured content leaves the gate pending without crashing", async (t) => {
  const dir = makeTempDir("no-details");
  resetWriteGateState(dir);
  t.after(() => {
    resetWriteGateState(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  setPendingGate("depth_verification_M002_confirm", dir);

  for (const handler of handlers.get("tool_result") ?? []) {
    await handler({
      toolCallId: "t-depth",
      toolName: "ask_user_questions",
      input: { questions: [{ id: "depth_verification_M002_confirm" }] },
      result: { content: [{ type: "text", text: "answered" }] },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), "depth_verification_M002_confirm");
});
