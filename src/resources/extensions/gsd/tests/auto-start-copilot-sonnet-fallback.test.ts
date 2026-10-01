// Regression guard: avoid noisy startup warning when Copilot temporarily
// omits claude-sonnet-5 / claude-sonnet-5.5 from the live model catalog.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copilotSonnetFallbackChain } from "../auto-start.ts";

const AUTO_START_PATH = join(import.meta.dirname, "..", "auto-start.ts");

function source(): string {
  return readFileSync(AUTO_START_PATH, "utf-8");
}

test("auto-start routes Copilot Sonnet 5.x catalog lag through the fallback chain", () => {
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

test("copilotSonnetFallbackChain prefers the nearest older Copilot Sonnet", () => {
  assert.deepEqual(copilotSonnetFallbackChain("claude-sonnet-5"), [
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-sonnet-4",
  ]);
  for (const id of ["claude-sonnet-5.5", "claude-sonnet-5-5"]) {
    assert.deepEqual(copilotSonnetFallbackChain(id), [
      "claude-sonnet-5",
      "claude-sonnet-4.6",
      "claude-sonnet-4.5",
      "claude-sonnet-4",
    ]);
  }
});

test("copilotSonnetFallbackChain leaves other models alone", () => {
  for (const id of ["claude-sonnet-4.6", "claude-opus-5-5", "gpt-5.5", "claude-sonnet-5-50"]) {
    assert.equal(copilotSonnetFallbackChain(id), undefined, id);
  }
});
