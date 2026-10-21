import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMilestoneTarget, parseModelFlag } from "../commands/handlers/auto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("parseMilestoneTarget", () => {
  it("extracts a simple milestone ID", () => {
    const result = parseMilestoneTarget("auto M016");
    assert.equal(result.milestoneId, "M016");
    assert.equal(result.rest, "auto");
  });

  it("extracts a milestone ID with unique suffix", () => {
    const result = parseMilestoneTarget("auto M001-a3b4c5 --verbose");
    assert.equal(result.milestoneId, "M001-a3b4c5");
    assert.equal(result.rest, "auto --verbose");
  });

  it("returns null when no milestone ID is present", () => {
    const result = parseMilestoneTarget("auto --verbose");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto --verbose");
  });

  it("extracts milestone ID with flags in any order", () => {
    const result = parseMilestoneTarget("auto --verbose M003 --debug");
    assert.equal(result.milestoneId, "M003");
    assert.equal(result.rest, "auto --verbose --debug");
  });

  it("returns null for plain 'auto'", () => {
    const result = parseMilestoneTarget("auto");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto");
  });

  it("extracts from 'next' command", () => {
    const result = parseMilestoneTarget("next M012");
    assert.equal(result.milestoneId, "M012");
    assert.equal(result.rest, "next");
  });

  it("handles milestone ID at the start of input", () => {
    const result = parseMilestoneTarget("M007");
    assert.equal(result.milestoneId, "M007");
    assert.equal(result.rest, "");
  });

  it("picks the first milestone ID when multiple appear", () => {
    // Edge case: user accidentally types two. First one wins.
    const result = parseMilestoneTarget("auto M001 M002");
    assert.equal(result.milestoneId, "M001");
    // M002 remains in rest since only the first match is removed
    assert.ok(result.rest.includes("M002"));
  });

  it("does not match bare numbers without M prefix", () => {
    const result = parseMilestoneTarget("auto 016");
    assert.equal(result.milestoneId, null);
  });
});

describe("auto preference diagnostics", () => {
  it("notifies preference diagnostics before launching auto-mode", () => {
    const source = readFileSync(join(__dirname, "..", "commands", "handlers", "auto.ts"), "utf-8");
    const autoBlockIndex = source.indexOf('if (trimmed === "auto" || trimmed.startsWith("auto "))');
    assert.ok(autoBlockIndex >= 0, "auto command block should exist");
    const nextBlockIndex = source.indexOf('if (trimmed === "stop")', autoBlockIndex);
    const autoBlock = source.slice(autoBlockIndex, nextBlockIndex);
    const notifyIndex = autoBlock.indexOf("notifyPreferenceDiagnostics");
    assert.ok(notifyIndex >= 0, "auto command should notify preference diagnostics");
    for (const match of autoBlock.matchAll(/startAutoDetached/g)) {
      assert.ok(
        notifyIndex < match.index!,
        "preference diagnostics should be notified before each auto-mode launch",
      );
    }
  });
});

describe("parseModelFlag", () => {
  it("extracts provider/model from --model", () => {
    const result = parseModelFlag("auto --model openrouter/openai/gpt-5.4");
    assert.equal(result.modelQuery, "openrouter/openai/gpt-5.4");
    assert.equal(result.rest, "auto");
  });

  it("extracts quoted model values", () => {
    const result = parseModelFlag('auto --model "openrouter/openai/gpt-5.4" --verbose');
    assert.equal(result.modelQuery, "openrouter/openai/gpt-5.4");
    assert.equal(result.rest, "auto --verbose");
  });

  it("returns null when --model is absent", () => {
    const result = parseModelFlag("auto --verbose M003");
    assert.equal(result.modelQuery, null);
    assert.equal(result.rest, "auto --verbose M003");
  });
});
