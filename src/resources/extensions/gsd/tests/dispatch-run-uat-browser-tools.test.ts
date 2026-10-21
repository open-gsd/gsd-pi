// Project/App: gsd-pi
// File Purpose: Regression coverage for run-uat browser tool availability checks.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import { BROWSER_AUTOMATION_CONTRACT_TOOLS } from "./browser-automation-contract-fixture.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  isDbAvailable,
  openDatabase,
} from "../gsd-db.ts";

type DispatchRuleEntry = (typeof DISPATCH_RULES)[number];

function runUatRule(): DispatchRuleEntry {
  const rule = DISPATCH_RULES.find((entry) => entry.name === "run-uat (post-completion)");
  assert.ok(rule, "run-uat dispatch rule must exist");
  return rule;
}

function makeState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Browser UAT" },
    activeSlice: { id: "S02", title: "Next Slice" },
    activeTask: null,
    phase: "verifying",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
}

/**
 * Seed the slice rows the run-uat dispatch gate reads. Post-cutover the gate
 * derives completed-slice candidates from DB rows only (`getMilestoneSlices`),
 * so the ROADMAP checkboxes this fixture writes are projection context; these
 * rows are the dispatch input.
 */
function seedSliceRows(): void {
  openDatabase(":memory:");
  assert.ok(isDbAvailable(), "fixture must have an open DB");
  insertMilestone({ id: "M001", title: "Browser UAT", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Completed browser slice",
    status: "complete",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  insertSlice({
    milestoneId: "M001",
    id: "S02",
    title: "Next slice",
    status: "pending",
    risk: "low",
    depends: ["S01"],
    sequence: 2,
  });
}

function scaffoldRunUatProject(basePath: string): void {
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });

  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
    "# M001: Browser UAT",
    "",
    "## Slices",
    "",
    "- [x] **S01: Completed browser slice** `risk:low` `depends:[]`",
    "- [ ] **S02: Next slice** `risk:low` `depends:[S01]`",
    "",
  ].join("\n"), "utf-8");

  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.\n", "utf-8");
  seedSliceRows();
  writeFileSync(join(sliceDir, "S01-UAT.md"), [
    "# S01 UAT",
    "",
    "## UAT Type",
    "- UAT mode: human-experience",
    "",
    "Open the app in a browser and verify the completed user flow.",
    "",
  ].join("\n"), "utf-8");
}

function makeContext(basePath: string, overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Browser UAT",
    state: makeState(),
    prefs: undefined,
    activeTools: ["read", "gsd_uat_exec", "gsd_uat_result_save"],
    ...overrides,
  };
}

test("run-uat browser preflight uses registered tools when the active surface is scoped", async (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-uat-browser-tools-"));
  t.after(() => {
    // The fixture seeds slice rows in an in-memory DB; close it so the next
    // test starts from a clean singleton.
    try { closeDatabase(); } catch { /* no DB open for this fixture */ }
    rmSync(basePath, { recursive: true, force: true });
  });
  scaffoldRunUatProject(basePath);

  const blocked = await runUatRule().match(makeContext(basePath));
  assert.equal(blocked?.action, "stop");
  assert.match(blocked?.action === "stop" ? blocked.reason : "", /run-uat tool surface has none/);

  const dispatched = await runUatRule().match(makeContext(basePath, {
    registeredTools: [...BROWSER_AUTOMATION_CONTRACT_TOOLS.piProvider],
  }));
  assert.equal(dispatched?.action, "dispatch");
  assert.equal(dispatched?.action === "dispatch" ? dispatched.unitType : undefined, "run-uat");
  assert.equal(dispatched?.action === "dispatch" ? dispatched.unitId : undefined, "M001/S01");
});
