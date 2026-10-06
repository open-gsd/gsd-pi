// gsd-pi — Deep planning mode end-to-end dispatch chain integration test.
//
// Unit-level tests (deep-planning-mode-dispatch.test.ts) invoke each
// rule's match() in isolation and miss ordering bugs. This test exercises
// resolveDispatch with all rules loaded and verifies that, in deep mode,
// the project-level stage gates fire in the correct order — even when
// state.phase is "needs-discussion" (which previously short-circuited
// to discuss-milestone before any deep rule could run).

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveDispatch, type DispatchContext } from "../auto-dispatch.ts";
import { closeDatabase, insertArtifact, insertMilestone, openDatabase } from "../gsd-db.ts";
import {
  isWorkflowPreferencesCaptured,
  recordResearchDecision,
  recordWorkflowPreferencesCaptured,
} from "../project-setup-facts.ts";
import type { GSDState } from "../types.ts";
import type { GSDPreferences } from "../preferences.ts";

function makeIsolatedBase(t: TestContext, scope: "milestone" | "project" = "milestone"): string {
  const base = join(tmpdir(), `gsd-deep-integration-${randomUUID()}`);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  if (scope === "milestone") {
    insertMilestone({ id: "M001", title: "Test", status: "active" });
  }
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function makeCtx(
  basePath: string,
  prefs: GSDPreferences | undefined,
  phase: GSDState["phase"] = "needs-discussion",
  mid: "M001" | "PROJECT" = "M001",
): DispatchContext {
  const projectSetup = mid === "PROJECT";
  const state: GSDState = {
    phase,
    activeMilestone: projectSetup ? null : { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: projectSetup ? [] : [{ id: "M001", title: "Test", status: "active" }],
  };
  return {
    basePath,
    mid,
    midTitle: projectSetup ? "Project" : "Test",
    state,
    prefs,
    structuredQuestionsAvailable: "false",
  };
}

// PREFERENCES.md as the workflow-preferences stage leaves it. The stage gate
// itself is the database fact recorded by writePreferences below.
const capturedPreferencesMd = `---
planning_depth: deep
workflow_prefs_captured: true
commit_policy: per-task
branch_model: single
uat_dispatch: true
models:
  executor_class: balanced
phases:
  skip_research: false
---
`;

const validProjectMd = [
  "# Project",
  "",
  "## What This Is",
  "",
  "A test project.",
  "",
  "## Core Value",
  "",
  "Reliable dispatch behavior.",
  "",
  "## Current State",
  "",
  "Tests are exercising deep planning.",
  "",
  "## Architecture / Key Patterns",
  "",
  "Markdown artifacts drive stage gates.",
  "",
  "## Capability Contract",
  "",
  "See `.gsd/REQUIREMENTS.md`.",
  "",
  "## Milestone Sequence",
  "",
  "- [ ] M001: Test - exercise deep planning dispatch",
  "",
].join("\n");

const validRequirementsMd = [
  "# Requirements",
  "",
  "## Active",
  "",
  "### R001 - Dispatch valid artifacts",
  "- Class: core-capability",
  "- Status: active",
  "- Description: Valid artifacts allow deep-mode dispatch to advance.",
  "- Why it matters: Stage gates must not stall valid projects.",
  "- Source: test",
  "- Primary owning slice: M001/S01",
  "- Supporting slices: none",
  "- Validation: unmapped",
  "- Notes:",
  "",
  "## Validated",
  "",
  "## Deferred",
  "",
  "## Out of Scope",
  "",
  "## Traceability",
  "",
  "| ID | Class | Status | Primary owner | Supporting | Proof |",
  "|---|---|---|---|---|---|",
  "| R001 | core-capability | active | M001/S01 | none | unmapped |",
  "",
  "## Coverage Summary",
  "",
  "- Active requirements: 1",
  "",
].join("\n");

function writePreferences(base: string): void {
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), capturedPreferencesMd);
  recordWorkflowPreferencesCaptured();
}

// The setup stages are database rows; the .gsd files are written too so the
// prompt builders that inline them still find their projection.
function saveRootArtifact(base: string, path: "PROJECT.md" | "REQUIREMENTS.md", content: string): void {
  insertArtifact({
    path,
    artifact_type: path.replace(".md", ""),
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: content,
  });
  writeFileSync(join(base, ".gsd", path), content);
}

function writeValidProject(base: string): void {
  saveRootArtifact(base, "PROJECT.md", validProjectMd);
}

function writeValidRequirements(base: string): void {
  saveRootArtifact(base, "REQUIREMENTS.md", validRequirementsMd);
}

// ─── Regression test for B1: rule ordering bug ────────────────────────────

test("integration: deep mode + needs-discussion + nothing captured → capture prefs then discuss-project", async (t) => {
  const base = makeIsolatedBase(t, "project");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch", `expected dispatch, got ${result.action}: ${JSON.stringify(result)}`);
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-project",
      "deep mode in needs-discussion must self-heal preferences before project discovery, not discuss milestone",
    );
  }
  const prefsContent = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(prefsContent, /^commit_policy:\s*per-task\s*$/m);
  assert.equal(isWorkflowPreferencesCaptured(), true);
  assert.equal(existsSync(join(base, ".gsd", "runtime", "research-decision.json")), false);
});

test("integration: deep mode + pre-planning + nothing captured → capture prefs then discuss-project", async (t) => {
  const base = makeIsolatedBase(t, "project");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "pre-planning", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
  const prefsContent = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.match(prefsContent, /^commit_policy:\s*per-task\s*$/m);
});

test("integration: deep mode + prefs captured + no PROJECT.md → discuss-project", async (t) => {
  const base = makeIsolatedBase(t, "project");

  writePreferences(base);

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
});

test("integration: deep mode + invalid PROJECT.md → discuss-project, not discuss-milestone", async (t) => {
  const base = makeIsolatedBase(t, "project");

  writePreferences(base);
  saveRootArtifact(base, "PROJECT.md", "# Project\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-project");
  }
});

test("integration: deep mode + PROJECT.md + no REQUIREMENTS.md → discuss-requirements", async (t) => {
  const base = makeIsolatedBase(t, "project");

  writePreferences(base);
  writeValidProject(base);

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
  }
});

test("integration: deep mode + invalid REQUIREMENTS.md → discuss-requirements, not discuss-milestone", async (t) => {
  const base = makeIsolatedBase(t, "project");

  writePreferences(base);
  writeValidProject(base);
  saveRootArtifact(base, "REQUIREMENTS.md", "# Requirements\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-requirements");
  }
});

test("integration: deep mode + REQUIREMENTS saved + no research decision → discuss-milestone", async (t) => {
  const base = makeIsolatedBase(t);

  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
  assert.equal(existsSync(join(base, ".gsd", "runtime", "research-decision.json")), false, "the skip default is not written");
});

test("integration: deep mode + decision=research + research files missing → research-project", async (t) => {
  const base = makeIsolatedBase(t, "project");

  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  recordResearchDecision("research");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
  }
});

test("integration: deep mode + leftover research-project marker file → research-project, not stop", async (t) => {
  const base = makeIsolatedBase(t, "project");

  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  recordResearchDecision("research");
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(join(base, ".gsd", "runtime", "research-project-inflight"), "{}\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion", "PROJECT"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "research-project");
  }
});

test("integration: deep mode + decision=research + dimension blocker → discuss-milestone", async (t) => {
  const base = makeIsolatedBase(t);

  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  recordResearchDecision("research");
  mkdirSync(join(base, ".gsd", "research"), { recursive: true });
  for (const name of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md"]) {
    writeFileSync(join(base, ".gsd", "research", name), "# done\n");
  }
  writeFileSync(join(base, ".gsd", "research", "PITFALLS-BLOCKER.md"), "# blocker\n");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "a dimension blocker should clear the project research gate",
    );
  }
});

test("integration: deep mode + decision=skip → falls through to discuss-milestone in needs-discussion", async (t) => {
  const base = makeIsolatedBase(t);

  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  recordResearchDecision("skip");

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "after all deep stage gates pass and user skipped research, milestone discussion should fire",
    );
  }
});

test("integration: deep mode + leftover research-decision.json → ignored, discusses milestone", async (t) => {
  const base = makeIsolatedBase(t);

  writePreferences(base);
  writeValidProject(base);
  writeValidRequirements(base);
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  const leftover = JSON.stringify({ decision: "research", source: "user" });
  writeFileSync(join(base, ".gsd", "runtime", "research-decision.json"), leftover);

  const prefs = { planning_depth: "deep" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(
      result.unitType,
      "discuss-milestone",
      "a file is not a research decision; with no database decision the default is skip",
    );
  }
  assert.equal(readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8"), leftover);
});

// ─── Light-mode regression check ──────────────────────────────────────────

test("integration: light mode (no prefs) + needs-discussion → discuss-milestone (unchanged behavior)", async (t) => {
  const base = makeIsolatedBase(t);

  const result = await resolveDispatch(makeCtx(base, undefined, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
});

test("integration: light mode + planning_depth=light + needs-discussion → discuss-milestone", async (t) => {
  const base = makeIsolatedBase(t);

  const prefs = { planning_depth: "light" } as GSDPreferences;
  const result = await resolveDispatch(makeCtx(base, prefs, "needs-discussion"));
  assert.strictEqual(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.strictEqual(result.unitType, "discuss-milestone");
  }
});
