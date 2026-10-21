import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_PATH = resolve(import.meta.dirname, "..", "model-router.ts");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("model-router keeps a single claude-sonnet-5 entry per routing table", () => {
  const src = readFileSync(SOURCE_PATH, "utf-8");

  assert.equal(
    countOccurrences(src, '"claude-sonnet-5": "standard"'),
    1,
    "MODEL_CAPABILITY_TIER must contain exactly one claude-sonnet-5 key",
  );

  assert.equal(
    countOccurrences(src, '"claude-sonnet-5": 0.003'),
    1,
    "MODEL_COST_PER_1K_INPUT must contain exactly one claude-sonnet-5 key",
  );

  assert.equal(
    countOccurrences(src, '"claude-sonnet-5":              { coding: 90, debugging: 85, research: 80, reasoning: 87, speed: 55, longContext: 80, instruction: 88 }'),
    1,
    "MODEL_CAPABILITY_PROFILES must contain exactly one claude-sonnet-5 key",
  );
});
