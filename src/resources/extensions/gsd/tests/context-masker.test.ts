import test from "node:test";
import assert from "node:assert/strict";

import {
  createObservationMask,
  createResponsesInputObservationMask,
  filterSupersededContextInjections,
  filterSupersededResponsesContextInjections,
  truncateContextResultMessages,
  truncateResponsesInputResultItems,
} from "../context-masker.js";
import { GSD_CONTEXT_MESSAGE_SENTINEL } from "../bootstrap/system-context.js";

// These helpers produce messages in the pi-ai LLM payload format
// (post-convertToLlm, pre-provider), which is what before_provider_request sees.

function userMsg(content: string) {
  return { role: "user", content: [{ type: "text", text: content }] };
}

function assistantMsg(content: string) {
  return { role: "assistant", content: [{ type: "text", text: content }] };
}

/** toolResult in pi-ai format: role "toolResult", content as TextContent[] */
function toolResult(text: string) {
  return { role: "toolResult", content: [{ type: "text", text }], toolCallId: "toolu_test", toolName: "Read", isError: false };
}

/** bashExecution after convertToLlm: becomes a user message with "Ran `cmd`" prefix */
function bashResult(text: string) {
  return { role: "user", content: [{ type: "text", text: `Ran \`echo test\`\n\`\`\`\n${text}\n\`\`\`` }] };
}

const MASK_TEXT = "[result masked — within summarized history]";

test("masks nothing when message count is within keepRecentTurns", () => {
  const mask = createObservationMask(8);
  const messages = [
    userMsg("hello"),
    assistantMsg("hi"),
    toolResult("file contents"),
  ];
  const result = mask(messages as any);
  assert.equal(result.length, 3);
  assert.deepEqual((result[2].content as any)[0].text, "file contents");
});

test("masks tool results older than a full quantization block", () => {
  // With keepRecentTurns=2, masking is quantized in blocks of 2 turns: nothing
  // is masked until a full block (2 turns) of excess history accumulates.
  const mask = createObservationMask(2);
  const messages = [
    userMsg("turn 1"),
    toolResult("turn 1 tool output"),
    assistantMsg("response 1"),
    userMsg("turn 2"),
    toolResult("turn 2 tool output"),
    assistantMsg("response 2"),
    userMsg("turn 3"),
    toolResult("turn 3 tool output"),
    assistantMsg("response 3"),
    userMsg("turn 4"),
    toolResult("turn 4 tool output"),
    assistantMsg("response 4"),
    userMsg("turn 5"),
    toolResult("turn 5 tool output"),
    assistantMsg("response 5"),
  ];
  const result = mask(messages as any);
  // First block (turns 1-2) is masked
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
  assert.equal((result[4].content as any)[0].text, MASK_TEXT);
  // Remaining turns (3-5) are within the unmasked window
  assert.equal((result[7].content as any)[0].text, "turn 3 tool output");
  assert.equal((result[10].content as any)[0].text, "turn 4 tool output");
  assert.equal((result[13].content as any)[0].text, "turn 5 tool output");
});

test("never masks assistant messages", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    assistantMsg("old reasoning"),
    userMsg("turn 2"),
    assistantMsg("new reasoning"),
  ];
  const result = mask(messages as any);
  assert.equal((result[1].content as any)[0].text, "old reasoning");
  assert.equal((result[3].content as any)[0].text, "new reasoning");
});

test("never masks user messages", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("old user message"),
    assistantMsg("response"),
    userMsg("new user message"),
    assistantMsg("response"),
  ];
  const result = mask(messages as any);
  assert.equal((result[0].content as any)[0].text, "old user message");
});

test("masks bash result user messages", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    bashResult("huge log output"),
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
});

test("returns same array length", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("a"), toolResult("b"), assistantMsg("c"),
    userMsg("d"), toolResult("e"), assistantMsg("f"),
  ];
  const result = mask(messages as any);
  assert.equal(result.length, messages.length);
});

test("masks toolResult by role, not by type field", () => {
  const mask = createObservationMask(1);
  const messages = [
    userMsg("turn 1"),
    // This is the actual pi-ai format: role "toolResult", no type field
    { role: "toolResult", content: [{ type: "text", text: "old result" }], toolCallId: "t1", toolName: "Read", isError: false },
    assistantMsg("response 1"),
    userMsg("turn 2"),
    assistantMsg("response 2"),
  ];
  const result = mask(messages as any);
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
});

function buildTurns(count: number) {
  const messages: unknown[] = [];
  for (let i = 1; i <= count; i++) {
    messages.push(userMsg(`turn ${i}`));
    messages.push(toolResult(`turn ${i} tool output`));
    messages.push(assistantMsg(`response ${i}`));
  }
  return messages;
}

function maskedTextsByTurn(mask: (m: any) => any[], messages: unknown[], turnCount: number): (string | undefined)[] {
  const result = mask(messages as any);
  const texts: (string | undefined)[] = [];
  for (let i = 0; i < turnCount; i++) {
    const toolResultIndex = i * 3 + 1;
    texts.push((result[toolResultIndex].content as any)[0].text);
  }
  return texts;
}

test("quantized mask invariant: at least keepRecentTurns most recent turns are always unmasked", () => {
  const N = 3;
  const mask = createObservationMask(N);
  for (let totalTurns = 1; totalTurns <= 20; totalTurns++) {
    const messages = buildTurns(totalTurns);
    const texts = maskedTextsByTurn(mask, messages, totalTurns);
    for (let i = Math.max(0, totalTurns - N); i < totalTurns; i++) {
      assert.notEqual(texts[i], MASK_TEXT, `turn ${i + 1} of ${totalTurns} should be unmasked`);
    }
  }
});

test("quantized mask invariant: at most 2*keepRecentTurns-1 turns are unmasked", () => {
  const N = 3;
  const mask = createObservationMask(N);
  for (let totalTurns = 1; totalTurns <= 20; totalTurns++) {
    const messages = buildTurns(totalTurns);
    const texts = maskedTextsByTurn(mask, messages, totalTurns);
    const unmaskedCount = texts.filter((t) => t !== MASK_TEXT).length;
    assert.ok(unmaskedCount <= 2 * N - 1, `expected <= ${2 * N - 1} unmasked turns at total=${totalTurns}, got ${unmaskedCount}`);
  }
});

test("quantized mask invariant: prefix is byte-stable except at block rollover", () => {
  const N = 3;
  const mask = createObservationMask(N);
  let previousTexts: (string | undefined)[] = [];
  for (let totalTurns = 1; totalTurns <= 20; totalTurns++) {
    const messages = buildTurns(totalTurns);
    const texts = maskedTextsByTurn(mask, messages, totalTurns);
    // Compare the shared prefix (turns 1..totalTurns-1) against the previous turn's run.
    let changedCount = 0;
    for (let i = 0; i < previousTexts.length; i++) {
      if (previousTexts[i] !== texts[i]) changedCount++;
    }
    // A block rollover flips at most N turns from unmasked to masked; otherwise 0 should change.
    assert.ok(changedCount === 0 || changedCount <= N, `turn ${totalTurns}: ${changedCount} prefix turns changed status`);
    previousTexts = texts;
  }
});

test("truncates recent bash result user messages", () => {
  const messages = [
    userMsg("turn 1"),
    bashResult("a".repeat(50)),
    assistantMsg("response 1"),
  ];
  const result = truncateContextResultMessages(messages as any, 10);
  const text = (result[1].content as any)[0].text;
  assert.ok(text.length < (messages[1].content as any)[0].text.length);
  assert.match(text, /…\[truncated\]/);
});

test("masks Responses API function outputs older than keepRecentTurns", () => {
  const mask = createResponsesInputObservationMask(1);
  const items = [
    { role: "user", content: [{ type: "input_text", text: "turn 1" }] },
    { type: "function_call_output", call_id: "call_1", output: "old output" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "response 1" }] },
    { role: "user", content: [{ type: "input_text", text: "turn 2" }] },
  ];
  const result = mask(items as any);
  assert.equal(result[1].output, MASK_TEXT);
});

test("masks Responses API bash result user items older than keepRecentTurns", () => {
  const mask = createResponsesInputObservationMask(1);
  const items = [
    { role: "user", content: [{ type: "input_text", text: "turn 1" }] },
    { role: "user", content: [{ type: "input_text", text: "Ran `npm test`\n```\nold output\n```" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "response 1" }] },
    { role: "user", content: [{ type: "input_text", text: "turn 2" }] },
  ];
  const result = mask(items as any);
  assert.equal((result[1].content as any)[0].text, MASK_TEXT);
});

test("truncates Responses API function outputs and recent bash result items", () => {
  const items = [
    { role: "user", content: [{ type: "input_text", text: "turn 1" }] },
    { type: "function_call_output", call_id: "call_1", output: "b".repeat(50) },
    { role: "user", content: [{ type: "input_text", text: "Ran `npm test`\n```\n" + "c".repeat(50) + "\n```" }] },
  ];
  const result = truncateResponsesInputResultItems(items as any, 12);

  assert.match(result[1].output as string, /…\[truncated\]/);
  assert.match((result[2].content as any)[0].text, /…\[truncated\]/);
  assert.ok((result[1].output as string).length < (items[1].output as string).length);
  assert.ok((result[2].content as any)[0].text.length < (items[2].content as any)[0].text.length);
});

function contextInjectionMsg(label: string) {
  return userMsg(`${GSD_CONTEXT_MESSAGE_SENTINEL}\n[MEMORY] turn=${label}`);
}

test("filterSupersededContextInjections keeps only the latest of three same-kind injections", () => {
  const messages = [
    userMsg("turn 1 prompt"),
    contextInjectionMsg("1"),
    assistantMsg("response 1"),
    userMsg("turn 2 prompt"),
    contextInjectionMsg("2"),
    assistantMsg("response 2"),
    userMsg("turn 3 prompt"),
    contextInjectionMsg("3"),
  ];
  const original = JSON.parse(JSON.stringify(messages));

  const result = filterSupersededContextInjections(messages as any);

  const survivors = result.filter((m: any) => (m.content?.[0]?.text ?? "").startsWith(GSD_CONTEXT_MESSAGE_SENTINEL));
  assert.equal(survivors.length, 1);
  assert.match((survivors[0] as any).content[0].text, /turn=3/);
  assert.equal(result.length, messages.length - 2);
  // Pure function — input array is untouched.
  assert.deepEqual(messages, original);
});

test("filterSupersededContextInjections keeps the latest injection overall across mixed kinds", () => {
  // buildContextMessage emits one message per turn (guided > forensics > memory);
  // the latest one already embeds the memory block when present, so "keep the
  // latest overall" is correct — no separate per-kind tracking needed.
  const memoryOnly = userMsg(`${GSD_CONTEXT_MESSAGE_SENTINEL}\n[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY]`);
  const guided = userMsg(`${GSD_CONTEXT_MESSAGE_SENTINEL}\n[GSD Context Metadata]\n- Memory supplied: yes\n\n[GUIDED EXECUTE]`);
  const messages = [userMsg("turn 1"), memoryOnly, assistantMsg("r1"), userMsg("turn 2"), guided];

  const result = filterSupersededContextInjections(messages as any);

  const survivors = result.filter((m: any) => (m.content?.[0]?.text ?? "").startsWith(GSD_CONTEXT_MESSAGE_SENTINEL));
  assert.equal(survivors.length, 1);
  assert.match((survivors[0] as any).content[0].text, /GUIDED EXECUTE/);
});

test("filterSupersededContextInjections dedupes legacy pre-sentinel injections via bracketed GSD markers", () => {
  // Sessions created before the sentinel existed carry the stable
  // "[GSD Context Metadata]" / "[GSD Guided Execute Context]" labels but no
  // sentinel prefix; resuming them must still collapse to the latest injection.
  const legacyMemory1 = userMsg("[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY] turn=1");
  const legacyMemory2 = userMsg("[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY] turn=2");
  const messages = [userMsg("turn 1"), legacyMemory1, assistantMsg("r1"), userMsg("turn 2"), legacyMemory2];

  const result = filterSupersededContextInjections(messages as any);

  const survivors = result.filter((m: any) => (m.content?.[0]?.text ?? "").startsWith("[GSD Context Metadata]"));
  assert.equal(survivors.length, 1);
  assert.match((survivors[0] as any).content[0].text, /turn=2/);
  assert.equal(result.length, messages.length - 1);
});

test("filterSupersededContextInjections never drops a real user message that starts with forensics prose", () => {
  // "Debug GSD itself." is the forensics prompt text — generic prose, not a
  // bracketed GSD marker. A user can legitimately type it; treating it as an
  // injection would silently delete real user input. Only sentinel/bracketed
  // injections may be superseded.
  const userAsk = userMsg("Debug GSD itself. Why does resume hang after a crash?");
  const injection = userMsg(`${GSD_CONTEXT_MESSAGE_SENTINEL}\n[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY]`);
  const messages = [userAsk, assistantMsg("r1"), userMsg("turn 2"), injection];

  const result = filterSupersededContextInjections(messages as any);

  assert.ok(result.some((m: any) => (m.content?.[0]?.text ?? "").startsWith("Debug GSD itself.")));
  assert.equal(result.length, messages.length);
});

test("filterSupersededContextInjections returns the array unchanged when no injections present", () => {
  const messages = [userMsg("hi"), assistantMsg("hello"), toolResult("data")];
  const result = filterSupersededContextInjections(messages as any);
  assert.equal(result, messages);
});

test("filterSupersededContextInjections preserves forensics opening prompt across follow-up reinjection", () => {
  const forensicsOpening =
    "Debug GSD itself. Trace the symptom to root cause in current source and produce a filing-ready GitHub issue.";
  const messages = [
    userMsg(forensicsOpening),
    assistantMsg("I found the root cause in auto-loop.ts."),
    userMsg("yes, create the issue"),
    userMsg(`${GSD_CONTEXT_MESSAGE_SENTINEL}\n${forensicsOpening}`),
    assistantMsg("Creating the issue now."),
    userMsg("also add the stack trace"),
    userMsg(`${GSD_CONTEXT_MESSAGE_SENTINEL}\n${forensicsOpening}\n\n## Follow-up\nalso add the stack trace`),
  ];

  const result = filterSupersededContextInjections(messages as any);

  assert.equal(result.length, messages.length - 1);
  assert.equal((result[0] as any).content[0].text, forensicsOpening);
  assert.match((result[5] as any).content[0].text, /Follow-up/);
});

test("filterSupersededResponsesContextInjections keeps only the latest injection in payload.input", () => {
  const items = [
    { role: "user", content: [{ type: "input_text", text: "turn 1" }] },
    { role: "user", content: [{ type: "input_text", text: `${GSD_CONTEXT_MESSAGE_SENTINEL}\n[MEMORY] turn=1` }] },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
    { role: "user", content: [{ type: "input_text", text: `${GSD_CONTEXT_MESSAGE_SENTINEL}\n[MEMORY] turn=2` }] },
  ];
  const original = JSON.parse(JSON.stringify(items));

  const result = filterSupersededResponsesContextInjections(items as any);

  const survivors = result.filter((i: any) => (i.content?.[0]?.text ?? "").startsWith(GSD_CONTEXT_MESSAGE_SENTINEL));
  assert.equal(survivors.length, 1);
  assert.match((survivors[0] as any).content[0].text, /turn=2/);
  assert.deepEqual(items, original);
});

test("filterSupersededResponsesContextInjections returns the array unchanged when no injections present", () => {
  const items = [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];
  const result = filterSupersededResponsesContextInjections(items as any);
  assert.equal(result, items);
});
