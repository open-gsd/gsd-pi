import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../../../../../packages/pi-ai/src/models.js";
import { streamSimpleAnthropic } from "../../../../../packages/pi-ai/src/providers/anthropic.js";
import { streamSimpleOpenAICompletions } from "../../../../../packages/pi-ai/src/providers/openai-completions.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "../../../../../packages/pi-ai/src/providers/openai-responses.js";
import type { Api, Context, Model, SimpleStreamOptions, StreamFunction } from "../../../../../packages/pi-ai/src/types.js";
import { sanitizeGitHubCopilotModels } from "../copilot-model-catalog.js";
import { synthesizeCopilotOverlayEntry } from "../copilot-overlay-writer.js";

const context: Context = {
  systemPrompt: "Diagnostic",
  messages: [{ role: "user", content: "Diagnostic", timestamp: 0 }],
};

function assertModelApi<T extends Api>(model: Model<Api>, api: T): asserts model is Model<T> {
  assert.equal(model.api, api);
}

async function capture<T extends Api>(
  stream: StreamFunction<T, SimpleStreamOptions>,
  model: Model<T>,
  reasoning?: SimpleStreamOptions["reasoning"],
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const result = await stream(model, context, {
    apiKey: "diagnostic-placeholder",
    reasoning,
    onPayload(value) {
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
      payload = structuredClone(value) as Record<string, unknown>;
      throw new Error("DIAGNOSTIC_PAYLOAD_CAPTURE");
    },
  }).result();
  assert.ok(payload, result.errorMessage);
  assert.match(result.errorMessage ?? "", /DIAGNOSTIC_PAYLOAD_CAPTURE/);
  return payload;
}

function record(id: string, overrides: Record<string, unknown> = {}) {
  const [value] = sanitizeGitHubCopilotModels({ data: [{
    id, name: id, tool_call: true, supported_endpoints: ["/responses"],
    vision: false, reasoning: true, limit: { context: 400000, output: 128000 },
    cost: { input: 0.2, output: 1.2, cache_read: 0, cache_write: 0 }, ...overrides,
  }] });
  assert.ok(value);
  return value;
}

test("offline reasoning diagnostics preserve working paths and correct the characterized bugs", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    throw new Error("NETWORK DISABLED");
  });

  await t.test("Responses forwards low through max", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      assert.deepEqual((await capture(streamSimpleOpenAIResponses, getModel("github-copilot", "gpt-5.6-sol"), effort)).reasoning,
        { effort, summary: "auto" });
    }
  });
  await t.test("Responses without effort leaves reasoning absent", async () => {
    assert.equal((await capture(streamOpenAIResponses, getModel("github-copilot", "gpt-5.6-sol"))).reasoning, undefined);
  });
  await t.test("MAI Flash maps xhigh to high", async () => {
    const payload = await capture(streamSimpleOpenAIResponses, getModel("github-copilot", "mai-code-1.1-flash"), "xhigh");
    assert.equal((payload.reasoning as Record<string, unknown>).effort, "high");
  });
  await t.test("Astra disabled effort controls clamp to off", async () => {
    const model = getModel("github-copilot", "gpt-6-astra");
    assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
    assert.equal(clampThinkingLevel(model, "xhigh"), "off");
    assert.equal((await capture(streamSimpleOpenAICompletions, model, "xhigh")).reasoning_effort, undefined);
  });
  await t.test("Sol disabled effort does not reach the wire", async () => {
    for (const effort of ["low", "high"] as const) {
      assert.equal((await capture(streamSimpleOpenAICompletions, getModel("github-copilot", "gpt-6.1-sol"), effort)).reasoning_effort, undefined);
    }
  });
  await t.test("explicit custom compatibility still transmits xhigh", async () => {
    const model = getModel("github-copilot", "gpt-6-astra");
    assert.equal((await capture(streamSimpleOpenAICompletions, {
      ...model, thinkingLevelMap: { xhigh: "xhigh" },
      compat: { ...model.compat, supportsReasoningEffort: true },
    }, "xhigh")).reasoning_effort, "xhigh");
  });
  await t.test("Fable disabled effort does not advertise xhigh", async () => {
    const model = getModel("github-copilot", "claude-fable-5");
    assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
    assert.equal((await capture(streamSimpleOpenAICompletions, model, "xhigh")).reasoning_effort, undefined);
  });
  await t.test("camelCase effort metadata is recognized", () => {
    assert.deepEqual(record("diagnostic-camel-case", { supportedReasoningEfforts: ["low", "xhigh"] }).execution.reasoningLevels, ["low", "xhigh"]);
  });
  await t.test("nested effort metadata is recognized", () => {
    assert.deepEqual(record("diagnostic-nested-effort", { capabilities: { supports: { reasoning_effort: ["low", "high", "xhigh"] } } }).execution.reasoningLevels,
      ["low", "high", "xhigh"]);
  });
  await t.test("snake-case effort metadata remains recognized", () => {
    assert.deepEqual(record("diagnostic-snake-case", { supported_reasoning_efforts: ["low", "high"] }).execution.reasoningLevels, ["low", "high"]);
  });
  await t.test("limited overlays do not invent off/minimal/medium", () => {
    assert.deepEqual(getSupportedThinkingLevels(synthesizeCopilotOverlayEntry(record("diagnostic-limited-effort",
      { supported_reasoning_efforts: ["low", "high"] }))), ["low", "high"]);
  });
  await t.test("matching Completions live metadata transmits xhigh", async () => {
    const model = synthesizeCopilotOverlayEntry(record("diagnostic-completions-effort", {
      supported_endpoints: ["/chat/completions"], supported_reasoning_efforts: ["low", "high", "xhigh"],
    }));
    assertModelApi(model, "openai-completions");
    assert.equal((await capture(streamSimpleOpenAICompletions, model, "xhigh")).reasoning_effort, "xhigh");
  });
  await t.test("empty live lists suppress static fallback", () => {
    assert.deepEqual(record("gpt-5.6-sol", { supported_reasoning_efforts: [] }).execution.reasoningLevels, []);
  });
  await t.test("Opus adaptive aliases survive synthesis, including implicit minimal-to-low", async () => {
    const staticModel = getModel("github-copilot", "claude-opus-4.7");
    const overlay = synthesizeCopilotOverlayEntry(record(staticModel.id, { supported_endpoints: ["/v1/messages"] }));
    assertModelApi(overlay, "anthropic-messages");
    for (const effort of ["minimal", "low", "xhigh"] as const) {
      const expected = await capture(streamSimpleAnthropic, staticModel, effort);
      const actual: Record<string, unknown> = await capture(streamSimpleAnthropic, overlay, effort);
      assert.deepEqual(actual.thinking, expected.thinking);
      assert.deepEqual(actual.output_config, expected.output_config);
    }
  });
  await t.test("Haiku still uses budgets, not adaptive effort", async () => {
    const payload = await capture(streamSimpleAnthropic, getModel("github-copilot", "claude-haiku-4.5"), "high");
    assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
    assert.equal(payload.output_config, undefined);
  });
  await t.test("no network calls were made", () => assert.equal(fetchCalls, 0));
});
