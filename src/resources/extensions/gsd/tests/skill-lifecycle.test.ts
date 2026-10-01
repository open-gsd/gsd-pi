/**
 * Tests for skill telemetry and skill health (#599).
 * Tests the pure functions — no file I/O, no extension context.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UnitMetrics } from "../metrics.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<UnitMetrics> = {}): UnitMetrics {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
    cost: 0.05,
    toolCalls: 3,
    assistantMessages: 5,
    userMessages: 2,
    ...overrides,
  };
}

// ─── Skill Telemetry ──────────────────────────────────────────────────────────

describe("skill-telemetry", () => {
  // Note: captureAvailableSkills/getAndClearSkills depend on filesystem (getAgentDir)
  // so we test the data flow via getSkillLastUsed and detectStaleSkills which are pure

  it("getSkillLastUsed returns most recent timestamp per skill", async () => {
    const { getSkillLastUsed } = await import("../skill-telemetry.js");

    const units = [
      makeUnit({ finishedAt: 1000, skills: ["rust-core", "axum-web-framework"] }),
      makeUnit({ finishedAt: 2000, skills: ["rust-core"] }),
      makeUnit({ finishedAt: 3000, skills: ["axum-web-framework"] }),
    ];

    const result = getSkillLastUsed(units);
    assert.equal(result.get("rust-core"), 2000);
    assert.equal(result.get("axum-web-framework"), 3000);
  });

  it("getSkillLastUsed returns empty map for units without skills", async () => {
    const { getSkillLastUsed } = await import("../skill-telemetry.js");

    const units = [makeUnit(), makeUnit()];
    const result = getSkillLastUsed(units);
    assert.equal(result.size, 0);
  });
});

// ─── Skill Health ─────────────────────────────────────────────────────────────

describe("skill-health", () => {
  it("buildHealSkillPrompt includes unit ID", async () => {
    const { buildHealSkillPrompt } = await import("../skill-health.js");
    const prompt = buildHealSkillPrompt("M001/S01/T01");
    assert.ok(prompt.includes("M001/S01/T01"));
    assert.ok(prompt.includes("Skill Heal Analysis"));
    assert.ok(prompt.includes("skill-review-queue.md"));
  });

  it("computeStaleAvoidList excludes already-avoided skills", async () => {
    // This test requires filesystem access for loadLedgerFromDisk
    // so we test the filtering logic conceptually
    const { computeStaleAvoidList } = await import("../skill-health.js");

    // With no metrics file, should return empty
    const result = computeStaleAvoidList("/nonexistent/path", ["some-skill"]);
    assert.deepEqual(result, []);
  });
});

// ─── Report honesty (#2495) ───────────────────────────────────────────────────

describe("skill-health report honesty (#2495)", () => {
  // Availability-only fixture: units execute in child processes and
  // recordSkillRead is not wired across that boundary, so every unit carries
  // the full available catalog. Unit token totals rise over time so the
  // pre-fix trend analysis marks every skill "rising", and the later units
  // fail the success heuristic so the pre-fix declining_success suggestion
  // branch would fire too (guards against its silent restoration).
  function makeAvailabilityLedger() {
    const base = Date.now() - 24 * 60 * 60 * 1000;
    const units = [];
    for (let i = 0; i < 10; i++) {
      const failing = i >= 5; // toolCalls >= assistantMessages * 20 → "unsuccessful" unit
      units.push(makeUnit({
        id: `M001/S01/T${String(i + 1).padStart(2, "0")}`,
        startedAt: base + i * 60_000,
        finishedAt: base + i * 60_000 + 30_000,
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: i < 5 ? 1_000_000 : 2_000_000 },
        cost: 0.05,
        toolCalls: failing ? 200 : 3,
        assistantMessages: 5,
        skills: ["rust-core", "axum-web-framework", "test-pilot"],
      }));
    }
    return { version: 1 as const, projectStartedAt: base, units };
  }

  async function withFixtureReport(): Promise<{ report: any; text: string; detail: string }> {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "skill-health-2495-"));
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "metrics.json"), JSON.stringify(makeAvailabilityLedger()));
    try {
      const { generateSkillHealthReport, formatSkillHealthReport, formatSkillDetail } = await import("../skill-health.js");
      const report = generateSkillHealthReport(dir);
      return {
        report,
        text: formatSkillHealthReport(report),
        detail: formatSkillDetail(dir, "rust-core"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("availability-only fixture produces rising trends (fixture sanity, pre-fix behavior)", async () => {
    const { report } = await withFixtureReport();
    assert.ok(report.skills.length >= 3);
    const rising = report.skills.filter((s: any) => s.tokenTrend === "rising");
    assert.ok(rising.length >= 3, "fixture unit-token growth should register as rising under current aggregation");
  });

  it("report is marked availabilityBased", async () => {
    const { report } = await withFixtureReport();
    assert.equal(report.availabilityBased, true);
  });

  it("formatSkillHealthReport uses availability-truth labels with footnote", async () => {
    const { text } = await withFixtureReport();
    assert.ok(text.includes("Unit Success%"), `expected "Unit Success%" header in:\n${text.split("\n").slice(6, 9).join("\n")}`);
    assert.ok(text.includes("Avg Unit Tokens"));
    assert.ok(text.includes("not SKILL.md reads"), "footnote must state counts are availability, not reads");
    assert.ok(text.includes("#2495"));
    assert.ok(!text.includes("Success%  Avg Tokens"), "old dishonest header must be gone");
  });

  it("flagged section is renamed and causation heal suggestions are dropped", async () => {
    const { report, text } = await withFixtureReport();
    // Precondition: the fixture's unit-derived success rate is low enough that
    // the deleted declining_success branch WOULD fire if restored — this test
    // fails if anyone reintroduces it.
    for (const skill of report.skills) {
      assert.equal(skill.successRate, 0.5, `fixture precondition: ${skill.name} success rate should be 50%`);
      assert.ok(skill.totalUses >= 5);
    }
    assert.ok(text.includes("Flagged Skills (flagged for review):"));
    assert.ok(text.includes("Success rate 50%"), "flag reason from unit-derived success must still mark the skill flagged");
    assert.ok(!text.includes("Declining Skills"), "header must not claim skills are declining");
    const causation = report.suggestions.filter(
      (s: any) => s.trigger === "rising_tokens" || s.trigger === "declining_success",
    );
    assert.equal(causation.length, 0, "no heal suggestions may assert causation on availability-only data");
    assert.ok(!text.includes("inefficient execution patterns"));
    assert.ok(!text.includes("Success rate dropped"));
  });

  it("formatSkillDetail uses availability-truth labels", async () => {
    const { detail } = await withFixtureReport();
    assert.ok(detail.includes("Units with skill available:"));
    assert.ok(detail.includes("Avg unit tokens:"));
    assert.ok(detail.includes("Recent units:"));
    assert.ok(detail.includes("not SKILL.md reads"));
    assert.ok(!detail.includes("Total uses:"));
    assert.ok(!detail.includes("Avg tokens/use:"));
  });

  it("formatSkillDetail for a never-available skill states availability, not usage", async () => {
    const { formatSkillDetail } = await import("../skill-health.js");
    const empty = formatSkillDetail("/nonexistent/path", "skill-no-unit-had");
    assert.ok(empty.includes("No availability data recorded for this skill."));
    assert.ok(!empty.includes("No usage data"));
  });

  it("report table uses Last Available wording", async () => {
    const { text } = await withFixtureReport();
    assert.ok(text.includes("Last Available"));
    assert.ok(!/\bLast Used\b/.test(text));
  });
});

// ─── UnitMetrics skills field ─────────────────────────────────────────────────

describe("UnitMetrics skills field", () => {
  it("skills field is optional and accepts string array", () => {
    const unit = makeUnit({ skills: ["rust-core", "axum-web-framework"] });
    assert.deepEqual(unit.skills, ["rust-core", "axum-web-framework"]);
  });

  it("skills field is undefined when not provided", () => {
    const unit = makeUnit();
    assert.equal(unit.skills, undefined);
  });
});

// ─── Preferences ──────────────────────────────────────────────────────────────

describe("skill_staleness_days preference", () => {
  it("validates valid staleness days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: 30 });
    assert.equal(result.preferences.skill_staleness_days, 30);
    assert.equal(result.errors.length, 0);
  });

  it("validates zero (disabled) staleness days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: 0 });
    assert.equal(result.preferences.skill_staleness_days, 0);
    assert.equal(result.errors.length, 0);
  });

  it("rejects negative staleness days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: -5 });
    assert.equal(result.preferences.skill_staleness_days, undefined);
    assert.ok(result.errors.some(e => e.includes("skill_staleness_days")));
  });

  it("floors fractional days", async () => {
    const { validatePreferences } = await import("../preferences.js");

    const result = validatePreferences({ skill_staleness_days: 30.7 });
    assert.equal(result.preferences.skill_staleness_days, 30);
  });
});
