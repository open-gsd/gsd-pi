import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRef, formatSnapshot } from "./snapshot.js";
import { redactSecrets, tail } from "./redact.js";

describe("formatSnapshot", () => {
  it("renders the compact snapshot and caps at 15 lines", () => {
    const text = formatSnapshot({
      activeMilestone: { id: "M001", title: "Hermes Integration" },
      activeSlice: { id: "S01", title: "Gateway MVP" },
      activeTask: null,
      phase: "execute",
      milestones: { total: 2, done: 1, active: 1 },
      slices: { total: 3, done: 1 },
      tasks: { total: 5, done: 2 },
      requirements: { active: 2, validated: 1 },
      blockers: ["b1", "b2", "b3", "b4"],
      nextAction: "Run contract tests",
    });
    const lines = text.split("\n");
    assert.equal(lines[0], "**GSD Project Snapshot**");
    assert.equal(lines[1], "Phase: execute");
    assert.equal(lines[2], "Active milestone: M001: Hermes Integration");
    assert.equal(lines[4], "Active task: —");
    assert.ok(lines.includes("Milestones: 1/2 done (1 active)"));
    assert.ok(lines.includes("Slices: 1/3 done"));
    assert.ok(lines.includes("Tasks: 2/5 done"));
    assert.ok(lines.includes("Requirements: 2 active, 1 validated"));
    assert.ok(lines.includes("  - b3"));
    assert.ok(!lines.includes("  - b4"), "only three blockers are shown");
    assert.ok(lines.length <= 15);
  });

  it("omits zero-count sections", () => {
    const text = formatSnapshot({
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "unknown",
      milestones: { total: 0, done: 0, active: 0 },
      slices: { total: 0, done: 0 },
      tasks: { total: 0, done: 0 },
      requirements: null,
      blockers: [],
      nextAction: "",
    });
    assert.equal(text.split("\n").length, 5);
  });

  it("formatRef degrades gracefully", () => {
    assert.equal(formatRef(null), "—");
    assert.equal(formatRef({ id: "M001", title: "M001" }), "M001");
    assert.equal(formatRef({ id: "M001", title: "Title" }, false), "M001");
  });
});

describe("redact", () => {
  it("masks keys, bearer tokens and KEY=value pairs", () => {
    // Fake credentials are assembled at runtime so secret scanners do not flag the literals.
    const bearer = ["Bearer", "abcdefghij1234"].join(" ");
    const envKey = ["sk", "ant", "1234567890abcdef"].join("-");
    const liveKey = ["sk", "live", "abcdefghijk"].join("-");
    const text = `auth failed: ${bearer} ANTHROPIC_API_KEY=${envKey} token: ${liveKey}`;
    const out = redactSecrets(text);
    assert.ok(!out.includes("abcdefghij1234"));
    assert.ok(!out.includes(envKey));
    assert.ok(!out.includes(liveKey));
    assert.match(out, /ANTHROPIC_API_KEY=\[redacted\]/);
  });

  it("tail keeps the last bytes", () => {
    assert.equal(tail("abcdef", 3), "def");
    assert.equal(tail("ab", 3), "ab");
  });
});
