// Project/App: gsd-pi
// File Purpose: Tests for per-message GSD dynamic-routing attribution (ADR-049, #2208).

import test from "node:test";
import assert from "node:assert/strict";

import {
  captureAssistantRoutingStart,
  clearPendingModelRouting,
  consumeAssistantRoutingEnd,
} from "../model-attribution.ts";

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "assistant", model: "gpt-5.6-luna", ...overrides };
}

test("a message that starts under light routing keeps the light snapshot even after the unit escalates", () => {
  clearPendingModelRouting();
  const mutableRouting = { tier: "light", modelDowngraded: false };
  captureAssistantRoutingStart(assistant(), mutableRouting, true);
  // Unit transition while the message is still streaming.
  mutableRouting.tier = "heavy";
  mutableRouting.modelDowngraded = true;

  const end = assistant({ stopReason: "stop" });
  const attributed = consumeAssistantRoutingEnd(end);
  assert.deepEqual(attributed?.modelRouting, { source: "gsd-dynamic", tier: "light", modelDowngraded: false });
});

test("the next assistant start consumes the updated unit routing", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "heavy", modelDowngraded: true }, true);
  const attributed = consumeAssistantRoutingEnd(assistant());
  assert.deepEqual(attributed?.modelRouting, { source: "gsd-dynamic", tier: "heavy", modelDowngraded: true });
});

test("a non-auto assistant message receives no field", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "light", modelDowngraded: false }, false);
  assert.equal(consumeAssistantRoutingEnd(assistant()), undefined);

  captureAssistantRoutingStart(assistant(), null, true);
  assert.equal(consumeAssistantRoutingEnd(assistant()), undefined);
});

test("user and toolResult messages are never decorated and never consume pending state", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "standard", modelDowngraded: false }, true);

  const userStart = { role: "user", content: "hi" };
  captureAssistantRoutingStart(userStart, { tier: "standard", modelDowngraded: false }, true);
  assert.equal(consumeAssistantRoutingEnd(userStart), undefined);

  const toolResultStart = { role: "toolResult", content: [] };
  assert.equal(consumeAssistantRoutingEnd(toolResultStart), undefined);

  const attributed = consumeAssistantRoutingEnd(assistant());
  assert.deepEqual(attributed?.modelRouting, { source: "gsd-dynamic", tier: "standard", modelDowngraded: false });
});

test("a missing message_end followed by a boundary clear cannot leak attribution to another turn", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "light", modelDowngraded: false }, true);
  clearPendingModelRouting();
  assert.equal(consumeAssistantRoutingEnd(assistant()), undefined);
});

test("consumption clears pending state: a second message_end is not decorated", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "light", modelDowngraded: false }, true);
  assert.ok(consumeAssistantRoutingEnd(assistant()));
  assert.equal(consumeAssistantRoutingEnd(assistant()), undefined);
});

test("a routing snapshot with an unknown tier is not attached", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "ultra", modelDowngraded: false }, true);
  assert.equal(consumeAssistantRoutingEnd(assistant()), undefined);
});

test("the replacement keeps the assistant role and all original fields", () => {
  clearPendingModelRouting();
  captureAssistantRoutingStart(assistant(), { tier: "light", modelDowngraded: false }, true);
  const end = assistant({
    provider: "openrouter",
    model: "openrouter/auto",
    responseModel: "anthropic/claude-opus-4.7",
    stopReason: "stop",
    usage: { totalTokens: 5 },
  });
  const attributed = consumeAssistantRoutingEnd(end);
  assert.equal(attributed?.role, "assistant");
  assert.equal(attributed?.provider, "openrouter");
  assert.equal(attributed?.model, "openrouter/auto");
  assert.equal(attributed?.responseModel, "anthropic/claude-opus-4.7");
  assert.equal(attributed?.stopReason, "stop");
  assert.deepEqual(attributed?.usage, { totalTokens: 5 });
  // The original message object is not mutated into the replacement.
  assert.equal("modelRouting" in end, false);
});
