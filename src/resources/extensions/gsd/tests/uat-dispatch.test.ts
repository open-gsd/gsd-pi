// Project/App: gsd-pi
// File Purpose: Tests for run-uat dispatch discovery boundaries.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkNeedsRunUat as checkNeedsRunUatFromPrompts } from "../auto-prompts.ts";
import {
  closeDatabase,
  insertAssessment,
  insertMilestone,
  insertSlice,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";
import { checkNeedsRunUat } from "../uat-dispatch.ts";
import type { GSDState } from "../types.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-uat-dispatch-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeRoadmap(base: string, milestoneId: string): void {
  const dir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${milestoneId}-ROADMAP.md`),
    [
      `# ${milestoneId}: UAT dispatch`,
      "",
      "## Slices",
      "",
      "- [x] **S01: First slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Next slice** `risk:low` `depends:[S01]`",
      "",
      "## Boundary Map",
      "",
    ].join("\n"),
  );
}

function writeSliceFile(
  base: string,
  milestoneId: string,
  sliceId: string,
  suffix: string,
  content: string,
): void {
  const dir = join(base, ".gsd", "milestones", milestoneId, "slices", sliceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sliceId}-${suffix}.md`), content);
}

test("checkNeedsRunUat resolves runtime harness dispatch from UAT plus summary context", async (t) => {
  const base = createFixtureBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: browser-executable",
      "",
      "## Preconditions",
      "- Start the dev server with `npm run test:server`.",
    ].join("\n"),
  );
  writeSliceFile(
    base,
    "M001",
    "S01",
    "SUMMARY",
    [
      "# S01 Summary",
      "",
      "Verification: `npm run test:uat` passed and exercises the browser harness end-to-end.",
    ].join("\n"),
  );

  assert.deepEqual(await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]), {
    sliceId: "S01",
    uatType: "runtime-executable",
  });
});

test("checkNeedsRunUat skips slices that already have an ASSESSMENT verdict", async (t) => {
  const base = createFixtureBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: artifact-driven",
    ].join("\n"),
  );
  writeSliceFile(base, "M001", "S01", "ASSESSMENT", "---\nverdict: PASS\n---\n# UAT Assessment\n");

  assert.equal(await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]), null);
});

test("checkNeedsRunUat retries a failed ASSESSMENT only during milestone closeout", async (t) => {
  const base = createFixtureBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    ["# S01 UAT", "", "## UAT Type", "- UAT mode: runtime-executable"].join("\n"),
  );
  writeSliceFile(base, "M001", "S01", "ASSESSMENT", "---\nverdict: FAIL\n---\n# UAT Assessment\n");

  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    null,
    "a failed UAT must not prevent later remediation slices from running",
  );
  assert.deepEqual(
    await checkNeedsRunUat(
      base,
      "M001",
      { uat_dispatch: true },
      [{ sliceId: "S01" }],
      { retryNonPass: true },
    ),
    { sliceId: "S01", uatType: "runtime-executable" },
    "closeout must make the documented failed-UAT recovery path reachable",
  );
});

test("checkNeedsRunUat does not retry roadmap-scoped assessments as UAT", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", risk: "low", depends: [] });
  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    "---\nverdict: PASS\n---\n# UAT\n\n## UAT Type\n- UAT mode: runtime-executable\n",
  );
  const assessmentPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md");
  writeFileSync(assessmentPath, "---\nverdict: FAIL\n---\n# Roadmap Assessment\n");
  insertAssessment({
    path: ".gsd/milestones/M001/slices/S01/S01-ASSESSMENT.md",
    milestoneId: "M001",
    sliceId: "S01",
    status: "fail",
    scope: "roadmap",
    fullContent: "verdict: FAIL",
  });

  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [], { retryNonPass: true }),
    null,
  );
});

test("auto-prompts keeps the compatibility checkNeedsRunUat wrapper", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // The wrapper derives its own candidates from DB rows (the roadmap checkbox
  // read it replaced is gone), so S01 must be a completed row for the wrapper
  // to have anything to dispatch.
  openDatabase(":memory:");
  assert.ok(isDbAvailable());
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "complete", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next slice", status: "pending", risk: "low", depends: ["S01"] });

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: human-experience",
    ].join("\n"),
  );

  const legacyState: GSDState = {
    activeMilestone: { id: "M001", title: "UAT dispatch" },
    activeSlice: { id: "S02", title: "Next slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan S02",
    registry: [],
  };

  assert.deepEqual(
    await checkNeedsRunUatFromPrompts(base, "M001", legacyState, { uat_dispatch: true }),
    { sliceId: "S01", uatType: "human-experience" },
  );
});

test("checkNeedsRunUat treats the DB as authoritative and ignores roadmap fallback when DB slices exist but none are complete", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // DB knows this milestone's slices, but none are complete.
  openDatabase(":memory:");
  assert.ok(isDbAvailable());
  insertMilestone({ id: "M001", title: "UAT dispatch", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "active", risk: "low", depends: [] });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Next slice", status: "pending", risk: "low", depends: [] });

  // The roadmap shows S01 completed and a dispatchable UAT file exists, so the
  // roadmap fallback *would* dispatch S01 if it were (incorrectly) consulted.
  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    ["# S01 UAT", "", "## UAT Type", "- UAT mode: human-experience"].join("\n"),
  );

  // DB is authoritative: no completed slices means no dispatch, and the roadmap
  // fallback candidate must NOT be consulted (regression for #1268).
  assert.equal(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    null,
  );
});

test("checkNeedsRunUat uses roadmap fallback candidates when the DB has no slice rows for the milestone", async (t) => {
  const base = createFixtureBase();
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // DB is available but has no rows for M001, so it has no authoritative view.
  openDatabase(":memory:");
  assert.ok(isDbAvailable());

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    ["# S01 UAT", "", "## UAT Type", "- UAT mode: human-experience"].join("\n"),
  );

  // With no DB slice rows, the roadmap-derived fallback candidate is honored.
  assert.deepEqual(
    await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]),
    { sliceId: "S01", uatType: "human-experience" },
  );
});
