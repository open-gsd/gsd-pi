// Project/App: gsd-pi
// File Purpose: Deep project setup stages are database facts: the gate, the dispatch rules and unit verification do not read setup files.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyExpectedArtifact } from "../artifact-verification.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import {
  DISPATCH_RULES,
  getDeepStageGate,
  setResearchProjectPromptBuilderForTest,
  type DispatchContext,
} from "../auto-dispatch.ts";
import { piExecutionInvocation } from "../execution-invocation.ts";
import { _getAdapter, closeDatabase, insertArtifact, insertMilestone, openDatabase } from "../gsd-db.ts";
import type { GSDPreferences } from "../preferences.ts";
import { isWorkflowPreferencesCaptured, readResearchDecision } from "../project-setup-facts.ts";
import { executeResearchDecisionSave } from "../tools/research-decision.ts";
import type { GSDState } from "../types.ts";

const deepPrefs = { planning_depth: "deep" } as GSDPreferences;

const VALID_PROJECT = readFileSync(new URL("../schemas/__fixtures__/valid-project.md", import.meta.url), "utf-8");
const VALID_REQUIREMENTS = readFileSync(new URL("../schemas/__fixtures__/valid-requirements.md", import.meta.url), "utf-8");

const PREFS_RULE = "deep: pre-planning (no workflow prefs) → workflow-preferences";
const PROJECT_RULE = "deep: pre-planning (no PROJECT) → discuss-project";
const REQUIREMENTS_RULE = "deep: pre-planning (no REQUIREMENTS) → discuss-requirements";
const RESEARCH_PROJECT_RULE = "deep: pre-planning (research approved, files missing) → research-project";

let base: string;

function gsdPath(...segments: string[]): string {
  return join(base, ".gsd", ...segments);
}

function saveRootArtifact(path: "PROJECT.md" | "REQUIREMENTS.md", content: string): void {
  insertArtifact({
    path,
    artifact_type: path.replace(".md", ""),
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: content,
  });
}

function ctx(): DispatchContext {
  const state: GSDState = {
    phase: "pre-planning",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }],
  };
  return { basePath: base, mid: "M001", midTitle: "Test", state, prefs: deepPrefs, structuredQuestionsAvailable: "false" };
}

function matchRule(name: string) {
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === name);
  assert.ok(rule, `dispatch rule "${name}" must exist`);
  return rule.match(ctx());
}

function gate(): { status: string; stage: string | null } {
  const { status, stage } = getDeepStageGate(deepPrefs, base);
  return { status, stage };
}

async function saveResearchDecision(decision: string, callId: string) {
  return executeResearchDecisionSave(
    { decision },
    base,
    piExecutionInvocation("gsd_research_decision_save", callId),
  );
}

describe("deep project setup reads database facts", () => {
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-deep-setup-db-")));
    mkdirSync(gsdPath(), { recursive: true });
    assert.equal(openDatabase(gsdPath("gsd.db")), true);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  test("setup does not restart when PROJECT.md and REQUIREMENTS.md are deleted", async () => {
    saveRootArtifact("PROJECT.md", VALID_PROJECT);
    saveRootArtifact("REQUIREMENTS.md", VALID_REQUIREMENTS);
    writeFileSync(gsdPath("PROJECT.md"), VALID_PROJECT);
    writeFileSync(gsdPath("REQUIREMENTS.md"), VALID_REQUIREMENTS);
    assert.deepEqual(gate(), { status: "complete", stage: null });

    rmSync(gsdPath("PROJECT.md"));
    rmSync(gsdPath("REQUIREMENTS.md"));

    assert.deepEqual(gate(), { status: "complete", stage: null });
    assert.equal(await matchRule(PROJECT_RULE), null);
    assert.equal(await matchRule(REQUIREMENTS_RULE), null);
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), true);
    assert.equal(verifyExpectedArtifact("discuss-requirements", "REQUIREMENTS", base), true);
  });

  test("setup files without database rows do not complete a stage", async () => {
    writeFileSync(gsdPath("PREFERENCES.md"), "---\nplanning_depth: deep\nworkflow_prefs_captured: true\n---\n");
    writeFileSync(gsdPath("PROJECT.md"), VALID_PROJECT);
    writeFileSync(gsdPath("REQUIREMENTS.md"), VALID_REQUIREMENTS);

    assert.deepEqual(gate(), { status: "pending", stage: "workflow-preferences" });
    assert.equal(verifyExpectedArtifact("workflow-preferences", "WORKFLOW-PREFS", base), false);
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), false);
    assert.equal(verifyExpectedArtifact("discuss-requirements", "REQUIREMENTS", base), false);
    const dispatched = await matchRule(PROJECT_RULE);
    assert.equal(dispatched?.action === "dispatch" ? dispatched.unitType : null, "discuss-project");
  });

  test("an invalid PROJECT row keeps the project stage pending", async () => {
    await matchRule(PREFS_RULE);
    saveRootArtifact("PROJECT.md", "# Project\n\nNo required sections.\n");

    assert.deepEqual(gate(), { status: "pending", stage: "project" });
    assert.equal(verifyExpectedArtifact("discuss-project", "PROJECT", base), false);
  });

  test("the workflow preferences stage is recorded in the database and read from it", async () => {
    assert.equal(isWorkflowPreferencesCaptured(), false);
    assert.deepEqual(gate(), { status: "pending", stage: "workflow-preferences" });

    assert.equal(await matchRule(PREFS_RULE), null);

    assert.equal(isWorkflowPreferencesCaptured(), true);
    assert.equal(verifyExpectedArtifact("workflow-preferences", "WORKFLOW-PREFS", base), true);
    rmSync(gsdPath("PREFERENCES.md"));
    assert.deepEqual(gate(), { status: "pending", stage: "project" });
  });

  test("resolving the gate writes no file and no database row", () => {
    saveRootArtifact("PROJECT.md", VALID_PROJECT);
    saveRootArtifact("REQUIREMENTS.md", VALID_REQUIREMENTS);
    const events = () => Number(
      _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_domain_events").get()?.["count"],
    );
    const eventsBefore = events();

    assert.deepEqual(gate(), { status: "complete", stage: null });

    assert.equal(events(), eventsBefore);
    assert.throws(() => readFileSync(gsdPath("PREFERENCES.md")), { code: "ENOENT" });
    assert.throws(() => readFileSync(gsdPath("runtime", "research-decision.json")), { code: "ENOENT" });
  });

  test("the research decision stays when .gsd/runtime is deleted", async () => {
    saveRootArtifact("PROJECT.md", VALID_PROJECT);
    saveRootArtifact("REQUIREMENTS.md", VALID_REQUIREMENTS);
    const saved = await saveResearchDecision("research", "call-1");
    assert.equal(saved.isError, undefined);
    mkdirSync(gsdPath("runtime"), { recursive: true });
    rmSync(gsdPath("runtime"), { recursive: true, force: true });

    assert.equal(readResearchDecision(), "research");
    assert.deepEqual(gate(), { status: "pending", stage: "project-research" });
  });

  test("a research decision recorded in a discuss unit makes project research the pending stage", async () => {
    for (const unitType of ["discuss-project", "discuss-requirements"]) {
      assert.equal(shouldBlockAutoUnitToolCall(unitType, "gsd_research_decision_save").block, false, unitType);
    }
    assert.equal(shouldBlockAutoUnitToolCall("execute-task", "gsd_research_decision_save").block, true);

    const saved = await saveResearchDecision("research", "call-1");
    assert.equal(saved.isError, undefined);
    assert.deepEqual(gate(), { status: "pending", stage: "workflow-preferences" });

    await matchRule(PREFS_RULE);
    saveRootArtifact("PROJECT.md", VALID_PROJECT);
    assert.deepEqual(gate(), { status: "pending", stage: "requirements" });
    saveRootArtifact("REQUIREMENTS.md", VALID_REQUIREMENTS);

    assert.deepEqual(gate(), { status: "pending", stage: "project-research" });
  });

  test("a research-decision.json file is not a research decision", () => {
    saveRootArtifact("PROJECT.md", VALID_PROJECT);
    saveRootArtifact("REQUIREMENTS.md", VALID_REQUIREMENTS);
    mkdirSync(gsdPath("runtime"), { recursive: true });
    writeFileSync(
      gsdPath("runtime", "research-decision.json"),
      JSON.stringify({ decision: "research", source: "user" }),
    );

    assert.equal(readResearchDecision(), null);
    assert.deepEqual(gate(), { status: "complete", stage: null });
  });

  test("the newest research decision wins and a retried tool call writes once", async () => {
    await saveResearchDecision("research", "call-1");
    await saveResearchDecision("skip", "call-2");
    const retried = await saveResearchDecision("skip", "call-2");

    assert.equal(retried.isError, undefined);
    assert.equal(readResearchDecision(), "skip");
    assert.equal(
      Number(_getAdapter()!.prepare(
        "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'project.setup.record'",
      ).get()?.["count"]),
      2,
    );
  });

  test("gsd_research_decision_save rejects a value that is not research or skip", async () => {
    const result = await saveResearchDecision("maybe", "call-1");

    assert.equal(result.isError, true);
    assert.equal(readResearchDecision(), null);
  });

  test("a research-project-inflight marker left by a crashed run of an older version does not block the research run", async (t) => {
    saveRootArtifact("PROJECT.md", VALID_PROJECT);
    saveRootArtifact("REQUIREMENTS.md", VALID_REQUIREMENTS);
    await saveResearchDecision("research", "call-1");
    t.after(setResearchProjectPromptBuilderForTest(async () => "research prompt"));
    mkdirSync(gsdPath("runtime"), { recursive: true });
    writeFileSync(gsdPath("runtime", "research-project-inflight"), "{}\n");

    const dispatched = await matchRule(RESEARCH_PROJECT_RULE);
    assert.equal(dispatched?.action === "dispatch" ? dispatched.unitType : dispatched?.action, "research-project");
  });
});
