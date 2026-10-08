// Regression guard: avoid noisy startup warning when Copilot temporarily
// omits claude-sonnet-5 from the live model catalog.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { copilotSonnetFallbackChain } from "../auto-start.ts";

const AUTO_START_PATH = join(import.meta.dirname, "..", "auto-start.ts");

function source(): string {
  return readFileSync(AUTO_START_PATH, "utf-8");
}

test("copilotSonnetFallbackChain steps down from Sonnet 5.5 through Sonnet 5 to 4.x", () => {
  assert.deepEqual(copilotSonnetFallbackChain("claude-sonnet-5.5"), [
    "claude-sonnet-5",
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-sonnet-4",
  ]);
  assert.deepEqual(copilotSonnetFallbackChain("claude-sonnet-5-5"), copilotSonnetFallbackChain("claude-sonnet-5.5"));
  assert.deepEqual(copilotSonnetFallbackChain("claude-sonnet-5"), ["claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4"]);
  assert.equal(copilotSonnetFallbackChain("claude-opus-5.5"), undefined);
});

test("auto-start applies the Copilot Sonnet fallback chain with an explicit notice", () => {
  const text = source();

  assert.match(
    text,
    /isCopilotProvider\s*\?\s*copilotSonnetFallbackChain\(preferredIdLower\)/,
    "startup should special-case Copilot Sonnet 5.x catalog lag",
  );

  assert.match(
    text,
    /is not currently exposed by Copilot; using .* for this session\./,
    "fallback path should emit an informational, explicit replacement notice",
  );
});
