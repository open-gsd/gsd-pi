// Project/App: gsd-pi
// File Purpose: Tests unit context composer rendering, budgets, and reassess-roadmap prompt integration.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CONTEXT_MODE_GUIDANCE_BY_UNIT,
  composeContractedUnitContext,
  composeContextModeInstructions,
  composeInlinedContext,
  composeToolSurfaceInstructions,
  composeUnitContext,
  manifestBudgetChars,
  type ArtifactResolver,
  type ExcerptResolver,
} from "../unit-context-composer.ts";
import { compileUnitContextContract } from "../tool-contract.ts";
import type {
  ArtifactKey,
  BaseResolverContext,
  ComputedArtifactRegistry,
  UnitContextManifest,
} from "../unit-context-manifest.ts";
import { KNOWN_UNIT_TYPES, UNIT_MANIFESTS } from "../unit-context-manifest.ts";
import { getUnitToolSurfaceContract } from "../unit-tool-contracts.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { resolveSubagentRole } from "../subagent-role-resolver.ts";
import type { UnitGsdToolName } from "../unit-registry.ts";
import {
  buildExecuteTaskPrompt,
  buildGateEvaluatePrompt,
  buildReactiveExecutePrompt,
  buildReassessRoadmapPrompt,
  buildWorkflowPreferencesPrompt,
  renderTaskRecoveryDispatchContext,
} from "../auto-prompts.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  openDatabase,
  closeDatabase,
  insertGateRow,
  insertMilestone,
  upsertMilestonePlanning,
  insertSlice,
  insertTask,
  saveReworkBrief,
} from "../gsd-db.ts";
import { clearGSDPreferencesCache, getProjectGSDPreferencesPath } from "../preferences.ts";

// ─── Pure composer tests ──────────────────────────────────────────────────

test("#4782 composer: returns empty string for unknown unit type", async () => {
  const out = await composeInlinedContext("never-dispatched", async () => "body");
  assert.strictEqual(out, "");
});

test("research tool guidance renders Claude Code agent types instead of internal roles", () => {
  const out = composeToolSurfaceInstructions("research-slice", {
    renderMode: "standalone",
    sessionProvider: "claude-code",
  });

  assert.match(out, /\*\*Explore\*\*/);
  assert.match(out, /\*\*Plan\*\*/);
  assert.doesNotMatch(out, /\*\*scout\*\*|\*\*planner\*\*/);
});

test("subagent role resolution preserves registered roles and falls back predictably", () => {
  assert.equal(resolveSubagentRole("scout", ["scout", "general-purpose"]), "scout");
  assert.equal(resolveSubagentRole("scout", ["Explore", "general-purpose"]), "Explore");
  assert.equal(resolveSubagentRole("tester", ["Explore", "general-purpose"]), "general-purpose");
});

test("#4782 composer: walks the manifest's inline list in declared order", async () => {
  // reassess-roadmap manifest keeps broad project docs out of inline context.
  const calls: ArtifactKey[] = [];
  const resolver: ArtifactResolver = async (key) => {
    calls.push(key);
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.deepEqual(calls, [
    "roadmap",
    "slice-context",
  ]);
  // Output joins blocks with the "---" separator.
  assert.match(out, /BODY:roadmap\n\n---\n\nBODY:slice-context/);
});

test("#4782 composer: null-returning resolvers are silently omitted", async () => {
  const resolver: ArtifactResolver = async (key) => {
    if (key === "slice-context" || key === "project") return null;
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  // slice-context + project skipped — not in output, no empty blocks
  assert.ok(!out.includes("BODY:slice-context"));
  assert.ok(!out.includes("BODY:project"));
  // Remaining keys still emitted in declared order
  assert.strictEqual(out, "BODY:roadmap");
});

test("#4782 composer: empty-string resolvers are omitted (treated as no-op)", async () => {
  const resolver: ArtifactResolver = async (key) => {
    if (key === "slice-context") return "";
    if (key === "slice-summary") return null;
    return `BODY:${key}`;
  };
  const out = await composeInlinedContext("reassess-roadmap", resolver);
  assert.ok(!out.includes("BODY:slice-context"));
  assert.ok(!out.includes("BODY:slice-summary"));
  // Must not leave double-separators when blocks are skipped
  assert.ok(!out.includes("---\n\n---"));
});

test("#4782 composer: resolver errors surface to caller", async () => {
  const resolver: ArtifactResolver = async () => {
    throw new Error("resolver boom");
  };
  await assert.rejects(
    () => composeInlinedContext("reassess-roadmap", resolver),
    /resolver boom/,
  );
});

test("#4782 composer: manifestBudgetChars returns declared budget", () => {
  const small = manifestBudgetChars("reassess-roadmap");
  assert.ok(small !== null && small > 0);
  assert.strictEqual(manifestBudgetChars("never-dispatched"), null);
});

test("Context Mode composer: disabled, unknown, and none modes return empty string", () => {
  assert.strictEqual(
    composeContextModeInstructions("execute-task", { enabled: false, renderMode: "standalone" }),
    "",
  );
  assert.strictEqual(
    composeContextModeInstructions("never-dispatched", { enabled: true, renderMode: "standalone" }),
    "",
  );
  assert.strictEqual(
    composeContextModeInstructions("workflow-preferences", { enabled: true, renderMode: "standalone" }),
    "",
  );
});

test("Context Mode composer: standalone output starts with heading and includes required tools", () => {
  const out = composeContextModeInstructions("execute-task", { enabled: true, renderMode: "standalone" });
  assert.ok(out.startsWith("## Context Mode"));
  assert.match(out, /execution lane/i);
  assert.match(out, /`gsd_exec`/);
  assert.match(out, /builds, tests, and diagnostics/);
  assert.match(out, /`gsd_exec_search`/);
  assert.match(out, /before reruns/);
  assert.match(out, /`gsd_resume`/);
  assert.match(out, /after compaction or resume/);
});

test("Context Mode composer: nested output is compact single sentence", () => {
  const out = composeContextModeInstructions("gate-evaluate", { enabled: true, renderMode: "nested" });
  assert.ok(!out.startsWith("## Context Mode"));
  assert.match(out, /^Context Mode \(verification lane\): /);
  assert.strictEqual(out.split(/\n/).length, 1);
  // Nested guidance is embedded into tester subagent prompts — it must instruct the tester
  // to run verification and call gsd_save_gate_result, NOT to dispatch further subagents.
  assert.doesNotMatch(out, /`subagent`/, "tester prompts must not be told to dispatch subagents");
  assert.match(out, /`gsd_save_gate_result`/);
  assert.doesNotMatch(out, /`gsd_exec`/);
  assert.doesNotMatch(out, /`gsd_exec_search`/);
  assert.doesNotMatch(out, /`gsd_resume`/);
  assert.ok(out.length < 240, `nested guidance should stay compact, got ${out.length} chars`);
});

const laneLabelByMode: Record<string, string> = {
  interview: "interview",
  research: "research",
  planning: "planning",
  execution: "execution",
  verification: "verification",
  orchestration: "orchestration",
  docs: "documentation",
  triage: "triage",
};

const contextModeGuidanceOverrideExpectedTools: Record<string, readonly string[]> = {
  "plan-milestone": [
    "gsd_milestone_status",
    "gsd_plan_milestone",
    "gsd_plan_slice",
    "gsd_plan_task",
    "gsd_decision_save",
    "gsd_requirement_update",
  ],
  "discuss-milestone": [
    "ask_user_questions",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_requirement_save",
    "gsd_requirement_update",
    "gsd_plan_milestone",
    "gsd_milestone_generate_id",
  ],
  "discuss-project": [
    "ask_user_questions",
    "gsd_summary_save",
    "gsd_decision_save",
    "gsd_requirement_save",
  ],
  "discuss-requirements": [
    "ask_user_questions",
    "gsd_requirement_save",
    "gsd_summary_save",
  ],
  "discuss-slice": [
    "ask_user_questions",
    "gsd_summary_save",
    "gsd_decision_save",
  ],
  "replan-slice": [
    "gsd_replan_slice",
    "gsd_decision_save",
  ],
  "reassess-roadmap": [
    "gsd_milestone_status",
    "gsd_reassess_roadmap",
  ],
  "run-uat": [
    "gsd_uat_exec",
    "gsd_resume",
  ],
  // research-project uses scout subagents that write .gsd/research/ files directly;
  // the parent dispatches Task calls and verifies file outputs — no GSD save tools.
  "research-project": [],
  "gate-evaluate": [
    "subagent",
    "gsd_save_gate_result",
  ],
};

test("Context Mode composer: every known eligible unit renders its configured lane and required tools", () => {
  for (const unitType of KNOWN_UNIT_TYPES) {
    const manifest = UNIT_MANIFESTS[unitType];
    assert.ok(manifest, `missing manifest for ${unitType}`);
    const out = composeContextModeInstructions(unitType, { enabled: true, renderMode: "standalone" });
    if (manifest.contextMode === "none") {
      assert.strictEqual(out, "", `${unitType} should not render Context Mode`);
      continue;
    }
    assert.ok(out.startsWith("## Context Mode"), `${unitType} should render standalone Context Mode heading`);
    assert.match(out, new RegExp(`Lane: \\*\\*${laneLabelByMode[manifest.contextMode]} lane\\*\\*\\.`, "i"));
    const forbidden = getUnitToolSurfaceContract(unitType)?.forbiddenGsdTools ?? {};
    const overrideExpectedTools = contextModeGuidanceOverrideExpectedTools[unitType];
    if ("gsd_exec" in forbidden || overrideExpectedTools) {
      // Unit overrides are the contract-specific exception to lane defaults.
      // Steering to the lane default here can produce unavailable-tool loops.
      assert.doesNotMatch(out, /`gsd_exec`/, `${unitType} guidance must not steer to gsd_exec`);
      assert.doesNotMatch(out, /`gsd_exec_search`/, `${unitType} guidance must not steer to gsd_exec_search`);
      for (const toolName of overrideExpectedTools ?? []) {
        assert.match(out, new RegExp(`\`${toolName}\``), `${unitType} guidance should mention ${toolName}`);
      }
    } else {
      assert.match(out, /`gsd_exec`/, `${unitType} should mention gsd_exec`);
      assert.match(out, /`gsd_exec_search`/, `${unitType} should mention gsd_exec_search`);
    }
    if (!overrideExpectedTools || overrideExpectedTools.includes("gsd_resume")) {
      assert.match(out, /`gsd_resume`/, `${unitType} should mention gsd_resume`);
    } else {
      assert.doesNotMatch(out, /`gsd_resume`/, `${unitType} guidance must not steer to gsd_resume`);
    }
  }
});

test("Context Mode composer: discuss interview overrides stay within unit contracts", () => {
  const discussUnits = [
    "discuss-milestone",
    "discuss-project",
    "discuss-requirements",
    "discuss-slice",
  ];

  for (const unitType of discussUnits) {
    const guidance = CONTEXT_MODE_GUIDANCE_BY_UNIT[unitType];
    assert.ok(guidance, `${unitType} should have a Context Mode override`);
    assert.doesNotMatch(guidance, /`gsd_exec`/, `${unitType} guidance must not mention gsd_exec`);
    assert.doesNotMatch(guidance, /`gsd_exec_search`/, `${unitType} guidance must not mention gsd_exec_search`);
    assert.doesNotMatch(guidance, /`gsd_resume`/, `${unitType} guidance must not mention gsd_resume`);

    const expectedTools = contextModeGuidanceOverrideExpectedTools[unitType] ?? [];
    assert.ok(expectedTools.length > 0, `${unitType} should declare expected override tools`);
    const contract = getUnitToolSurfaceContract(unitType);
    assert.ok(contract, `${unitType} should have a tool contract`);
    const contractTools = new Set([
      ...contract.allowedGsdTools,
      ...contract.requiredWorkflowTools,
    ]);

    for (const toolName of expectedTools) {
      assert.match(guidance, new RegExp(`\`${toolName}\``), `${unitType} guidance should mention ${toolName}`);
      assert.ok(contractTools.has(toolName as UnitGsdToolName), `${unitType} contract should allow ${toolName}`);
      const scope = shouldBlockAutoUnitToolCall(unitType, toolName);
      assert.equal(scope.block, false, `${unitType} should not hard-block ${toolName}: ${scope.reason ?? ""}`);
    }

    const out = composeContextModeInstructions(unitType, { enabled: true, renderMode: "standalone" });
    if (out) {
      assert.match(out, /interview lane/i);
      assert.doesNotMatch(out, /`gsd_exec`/);
      assert.doesNotMatch(out, /`gsd_exec_search`/);
      assert.doesNotMatch(out, /`gsd_resume`/);
    }
  }
});

test("Context Mode composer: run-uat guidance steers to gsd_uat_exec in both render modes", () => {
  const nested = composeContextModeInstructions("run-uat", { enabled: true, renderMode: "nested" });
  assert.match(nested, /^Context Mode \(verification lane\): /);
  assert.match(nested, /`gsd_uat_exec`/);
  assert.doesNotMatch(nested, /`gsd_exec`/);
  const standalone = composeContextModeInstructions("run-uat", { enabled: true, renderMode: "standalone" });
  assert.match(standalone, /`gsd_uat_exec`/);
  assert.doesNotMatch(standalone, /`gsd_exec`/);
});

test("Context Mode composer: research-project guidance steers to reconnaissance orchestration", () => {
  for (const renderMode of ["nested", "standalone"] as const) {
    const out = composeContextModeInstructions("research-project", { enabled: true, renderMode });
    assert.match(out, /research lane/i);
    assert.match(out, /reconnaissance subagents/i);
    assert.match(out, /\.gsd\/research\//);
    assert.match(out, /STACK\.md/);
    assert.match(out, /PITFALLS\.md/);
    assert.doesNotMatch(out, /`gsd_summary_save`/);
    assert.doesNotMatch(out, /`gsd_decision_save`/);
    assert.doesNotMatch(out, /`gsd_exec`/);
    assert.doesNotMatch(out, /`gsd_exec_search`/);
    assert.doesNotMatch(out, /`gsd_resume`/);
  }

  const contract = getUnitToolSurfaceContract("research-project");
  assert.deepEqual(contract?.allowedGsdTools, []);
  assert.deepEqual(contract?.requiredWorkflowTools, []);
  for (const toolName of ["gsd_summary_save", "gsd_decision_save"]) {
    const scope = shouldBlockAutoUnitToolCall("research-project", toolName);
    assert.equal(scope.block, true, `research-project should not allow ${toolName}`);
  }
});

test("Context Mode composer: narrow planning guidance steers only to contracted tools", () => {
  const cases = [
    {
      unitType: "plan-milestone",
      expectedTools: [
        "gsd_milestone_status",
        "gsd_plan_milestone",
        "gsd_plan_slice",
        "gsd_plan_task",
        "gsd_decision_save",
        "gsd_requirement_update",
      ],
    },
    {
      unitType: "replan-slice",
      expectedTools: ["gsd_replan_slice", "gsd_decision_save"],
    },
    {
      unitType: "reassess-roadmap",
      expectedTools: ["gsd_milestone_status", "gsd_reassess_roadmap"],
    },
  ];
  const disallowedTools = ["gsd_exec", "gsd_exec_search", "gsd_resume"];

  for (const { unitType, expectedTools } of cases) {
    for (const renderMode of ["nested", "standalone"] as const) {
      const out = composeContextModeInstructions(unitType, { enabled: true, renderMode });
      assert.match(out, /planning lane/i, `${unitType} should still render planning lane guidance`);
      for (const toolName of expectedTools) {
        assert.ok(out.includes(`\`${toolName}\``), `${unitType} guidance should mention ${toolName}`);
      }
      for (const toolName of disallowedTools) {
        assert.ok(!out.includes(`\`${toolName}\``), `${unitType} guidance must not mention ${toolName}`);
      }
    }
  }
});

test("Context Mode composer: lane guidance tools pass unit contracts", () => {
  const affectedUnits = [
    "research-milestone",
    "research-slice",
    "plan-slice",
    "refine-slice",
    "complete-slice",
    "validate-milestone",
    "complete-milestone",
  ];
  const contextModeTools: UnitGsdToolName[] = ["gsd_exec", "gsd_exec_search", "gsd_resume"];
  const readOnlyOrientationTools: UnitGsdToolName[] = ["gsd_milestone_status", ...contextModeTools];

  for (const unitType of affectedUnits) {
    const out = composeContextModeInstructions(unitType, { enabled: true, renderMode: "standalone" });
    const allowed = new Set(getUnitToolSurfaceContract(unitType)?.allowedGsdTools ?? []);

    for (const toolName of contextModeTools) {
      assert.ok(out.includes(`\`${toolName}\``), `${unitType} guidance should mention ${toolName}`);
    }
    const expectedContractTools = unitType === "research-milestone"
      ? contextModeTools
      : readOnlyOrientationTools;
    for (const toolName of expectedContractTools) {
      assert.ok(allowed.has(toolName), `${unitType} contract should allow ${toolName}`);
      const scope = shouldBlockAutoUnitToolCall(unitType, toolName);
      assert.equal(scope.block, false, `${unitType} should not hard-block ${toolName}: ${scope.reason ?? ""}`);
    }
  }
});

test("Context Mode composer: workflow-preferences and research-decision render no Context Mode block", () => {
  assert.strictEqual(
    composeContextModeInstructions("workflow-preferences", { enabled: true, renderMode: "standalone" }),
    "",
  );
  assert.strictEqual(
    composeContextModeInstructions("research-decision", { enabled: true, renderMode: "standalone" }),
    "",
  );
});

test("Tool Surface composer: run-uat forbids gsd_exec and Bash", () => {
  const out = composeToolSurfaceInstructions("run-uat", { renderMode: "standalone" });
  assert.match(out, /^## Tool Surface/);
  assert.match(out, /Do not call `gsd_exec`/);
  assert.match(out, /`Bash`/);
  assert.match(out, /`gsd_uat_exec`/);
  assert.match(out, /`gsd_save_gate_result`/);
  assert.match(out, /`gsd_summary_save`/);
});

test("Tool Surface composer: complete-slice steers verification to gsd_exec", () => {
  const out = composeToolSurfaceInstructions("complete-slice", { renderMode: "standalone" });
  assert.match(out, /`gsd_exec`/);
  assert.match(out, /not direct `bash`/);
  assert.match(out, /`gsd_uat_result_save`/);
});

test("Tool Surface composer: planning units restrict writes to .gsd", () => {
  const out = composeToolSurfaceInstructions("discuss-milestone", { renderMode: "standalone" });
  assert.match(out, /restricted to `\.gsd\/\*\*`/);
  assert.match(out, /`ask_user_questions`/);
});

test("Tool Surface composer: planning-dispatch lists allowed subagents", () => {
  const out = composeToolSurfaceInstructions("plan-slice", { renderMode: "standalone" });
  assert.match(out, /\*\*scout\*\*/);
  assert.match(out, /\*\*planner\*\*/);
  assert.match(out, /`gsd_exec`/);
  assert.match(out, /active worktree/);
});

test("Tool Surface composer: planning_subagents updates plan-milestone dispatch guidance", (t) => {
  const originalGsdHome = process.env.GSD_HOME;
  const tempProject = mkdtempSync(join(tmpdir(), "gsd-tool-surface-planning-subagents-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-tool-surface-planning-subagents-home-"));

  t.after(() => {
    clearGSDPreferencesCache();
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempProject, { recursive: true, force: true });
    rmSync(tempGsdHome, { recursive: true, force: true });
  });

  process.env.GSD_HOME = tempGsdHome;
  mkdirSync(join(tempProject, ".gsd"), { recursive: true });
  clearGSDPreferencesCache();
  writeFileSync(
    getProjectGSDPreferencesPath(tempProject),
    [
      "---",
      "version: 1",
      "planning_subagents:",
      "  plan-milestone:",
      "    allowed: [security]",
      "---",
      "",
    ].join("\n"),
    "utf-8",
  );

  const out = composeToolSurfaceInstructions("plan-milestone", {
    renderMode: "standalone",
    basePath: tempProject,
  });
  assert.match(out, /Dispatch subagents only to \*\*security\*\*/);
  assert.doesNotMatch(out, /Do not dispatch subagents/);
});

test("Tool Surface composer: execute-task warns against slice/milestone closeout tools", () => {
  const out = composeToolSurfaceInstructions("execute-task", { renderMode: "nested" });
  assert.match(out, /^Tool surface: /);
  assert.match(out, /`gsd_task_complete`/);
  assert.match(out, /Do not call `gsd_slice_complete`/);
});

test("Tool Surface composer: unknown unit renders empty block", () => {
  assert.strictEqual(
    composeToolSurfaceInstructions("never-dispatched", { renderMode: "standalone" }),
    "",
  );
});

// ─── Integration: migrated buildReassessRoadmapPrompt ─────────────────────

function makeFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-composer-pilot-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  invalidateAllCaches();
  rmSync(base, { recursive: true, force: true });
}

function seed(base: string, mid: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: mid, title: "Test", status: "active", depends_on: [] });
  upsertMilestonePlanning(mid, {
    title: "Test",
    status: "active",
    vision: "Ship it",
    successCriteria: ["It ships"],
    keyRisks: [],
    proofStrategy: [],
    verificationContract: "",
    verificationIntegration: "",
    verificationOperational: "",
    verificationUat: "",
    definitionOfDone: [],
    requirementCoverage: "",
    boundaryMapMarkdown: "",
  });
  insertSlice({
    id: "S01",
    milestoneId: mid,
    title: "First",
    status: "complete",
    risk: "low",
    depends: [],
    demo: "",
    sequence: 1,
  });
}

function writeArtifacts(base: string): void {
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n",
  );
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    "---\nid: S01\nparent: M001\n---\n# S01 Summary\n**One-liner**\n\n## What Happened\nDone.\n",
  );
}

test("#4782 phase 2: buildReassessRoadmapPrompt emits composer-shaped context with manifest-declared artifacts", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);

  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);

  // Context block wrapper from capPreamble
  assert.match(prompt, /## Inlined Context \(preloaded — do not re-read these files\)/);

  // Roadmap inlined first (manifest order)
  assert.match(prompt, /### Current Roadmap/);
  assert.match(prompt, /S01: First/);

  // Slice summary present
  assert.match(prompt, /### S01 Summary \(excerpt\)/);
  assert.match(prompt, /One-liner/);
  assert.ok(!prompt.includes("## What Happened\nDone."), "reassess prompt should not inline full completed-slice narrative");

  // Broad project docs are advertised on demand instead of fully inlined.
  assert.match(prompt, /### On-demand Planning Context/);
  assert.match(prompt, /\.gsd\/PROJECT\.md/);
  assert.match(prompt, /\.gsd\/REQUIREMENTS\.md/);
  assert.match(prompt, /\.gsd\/DECISIONS\.md/);

  // Slice context is optional and not present in this fixture — must not
  // leave a stray empty section
  assert.ok(!prompt.includes("Slice Context (from discussion)"));
});


test("execute-task prompt injects unresolved blocking rework findings", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  saveReworkBrief({
    briefId: "RB-001",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    findings: [{
      findingId: "F1",
      severity: "blocking",
      description: "Compile regression",
      requiredFix: "Restore typecheck",
      verificationCommands: ["pnpm run typecheck:extensions"],
    }],
  });

  const prompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T01", "Task", base);

  assert.match(prompt, /Blocking Rework Findings \(non-optional\)/);
  assert.match(prompt, /F1/);
  assert.match(prompt, /Compile regression/);
  assert.match(prompt, /pnpm run typecheck:extensions/);
  assert.match(prompt, /reworkResolution/);
});

test("execute-task prompt resolves an inline slice task without a standalone task plan", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Inline task", status: "pending" });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    [
      "# S01: First",
      "",
      "<tasks>",
      "- [ ] **T01**: Earlier task",
      "- [ ] **T02**: Inline task",
      "  - Files: `src/inline.ts`",
      "  - Verify: pnpm test inline",
      "</tasks>",
      "",
    ].join("\n"),
  );

  const prompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T02", "Inline task", base);

  assert.match(prompt, /Source: `\.gsd\/milestones\/M001\/slices\/S01\/S01-PLAN\.md`/);
  assert.match(prompt, /\*\*T02\*\*: Inline task/);
  assert.match(prompt, /src\/inline\.ts/);
  assert.doesNotMatch(prompt, /Task plan not found at dispatch time/);
  assert.doesNotMatch(prompt, /tasks\/T02-PLAN\.md/);
});

test("execute-task prompt prefers durable inline task planning state when no task file exists", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  insertTask({
    id: "T02",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Durable task",
    status: "pending",
    planning: {
      description: "Implement the durable inline contract.",
      estimate: "1h",
      files: ["src/durable.ts"],
      verify: "pnpm test durable",
      inputs: [],
      expectedOutput: ["src/durable.ts"],
      observabilityImpact: "none",
      fullPlanMd: "# T02: Durable task\n\nImplement the durable inline contract.\n",
    },
  });

  const prompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T02", "Durable task", base);

  assert.match(prompt, /Source: durable task planning state for M001\/S01\/T02/);
  assert.match(prompt, /Implement the durable inline contract/);
  assert.doesNotMatch(prompt, /Task plan not found at dispatch time/);
});

test("reactive execute-task dispatch resolves inline slice task plans", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Inline reactive task", status: "pending" });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    [
      "# S01: First",
      "",
      "<tasks>",
      "- [ ] **T02**: Inline reactive task",
      "  - Files: `src/reactive-inline.ts`",
      "  - Verify: pnpm test reactive-inline",
      "</tasks>",
      "",
    ].join("\n"),
  );

  const prompt = await buildReactiveExecutePrompt(
    "M001",
    "Recovery",
    "S01",
    "First",
    ["T02"],
    base,
  );

  assert.match(prompt, /Source: `\.gsd\/milestones\/M001\/slices\/S01\/S01-PLAN\.md`/);
  assert.match(prompt, /src\/reactive-inline\.ts/);
  assert.doesNotMatch(prompt, /Task plan not found at dispatch time/);
  assert.doesNotMatch(prompt, /tasks\/T02-PLAN\.md/);
});

test("execute-task recovery context gives repair, remediation, and replan distinct executor contracts", () => {
  const base = {
    recoveryActionId: "action-1",
    attemptId: "attempt-1",
    resultId: "result-1",
    failureKind: "verification-failed",
    summary: "Host verification failed",
    evidence: { command: "pnpm test", exitCode: 1 },
    rationale: "The failing evidence must be resolved before acceptance.",
    replanCompleted: false,
    checkpoint: {
      checkpointId: "checkpoint-1",
      confirmedContext: "Host verification failed",
      unresolvedSummary: "verification-failed",
      evidenceSummary: '{"command":"pnpm test","exitCode":1}',
      suggestedNextAction: "recover",
    },
  } as const;

  const repair = renderTaskRecoveryDispatchContext({ ...base, action: "repair" });
  const remediate = renderTaskRecoveryDispatchContext({ ...base, action: "remediate" });
  const replan = renderTaskRecoveryDispatchContext({ ...base, action: "replan" });

  for (const block of [repair, remediate, replan]) {
    assert.match(block, /action-1/);
    assert.match(block, /attempt-1/);
    assert.match(block, /Host verification failed/);
    assert.match(block, /pnpm test/);
    assert.match(block, /The failing evidence must be resolved/);
    assert.match(block, /checkpoint-1/);
  }
  assert.match(repair, /repair the deterministic execution fault before continuing/i);
  assert.doesNotMatch(repair, /gsd_replan_task/);
  assert.match(remediate, /fix the failed verification evidence and rerun verification/i);
  assert.doesNotMatch(remediate, /gsd_replan_task/);
  assert.match(replan, /current task plan is superseded/i);
  assert.match(replan, /planning unit must call `gsd_replan_task`, then stop before implementation/i);

  const completedReplan = renderTaskRecoveryDispatchContext({
    ...base,
    action: "replan",
    replanCompleted: true,
  });
  assert.match(completedReplan, /replacement Task plan is durable/i);
  assert.doesNotMatch(completedReplan, /must call `gsd_replan_task`/i);

  const replanContract = getUnitToolSurfaceContract("replan-task");
  assert.deepEqual(replanContract?.allowedGsdTools, ["gsd_replan_task", "gsd_decision_save"]);
  assert.deepEqual(replanContract?.requiredWorkflowTools, ["gsd_replan_task"]);
  const executeContract = getUnitToolSurfaceContract("execute-task");
  assert.ok(!executeContract?.allowedGsdTools.includes("gsd_replan_task"));
  assert.ok(!executeContract?.requiredWorkflowTools.includes("gsd_replan_task"));
});

test("execute-task prompt omits on-demand slice research when the artifact is absent", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);

  const prompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T01", "Task", base);

  assert.doesNotMatch(prompt, /## On-demand Context/);
  assert.doesNotMatch(prompt, /\.gsd\/milestones\/M001\/slices\/S01\/S01-RESEARCH\.md/);
});

test("execute-task prompt surfaces on-demand slice research when the artifact exists", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
    "# S01 Research\n",
  );

  const prompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T01", "Task", base);

  assert.match(prompt, /## On-demand Context/);
  assert.match(prompt, /\.gsd\/milestones\/M001\/slices\/S01\/S01-RESEARCH\.md/);
  assert.match(prompt, /Read it only if the inlined task plan, slice plan excerpt, and carry-forward context do not explain/);
});

test("Context Mode resume injection: eligible prompts include one bounded snapshot block above inlined context", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);
  writeFileSync(
    join(base, ".gsd", "last-snapshot.md"),
    "# GSD context snapshot\n\nResume evidence.\n",
    "utf-8",
  );

  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);

  assert.equal(prompt.match(/## Context Snapshot/g)?.length, 1);
  assert.match(prompt, /Source: `\.gsd\/last-snapshot\.md`/);
  assert.match(prompt, /Resume evidence/);
  assert.ok(prompt.indexOf("## Context Mode") < prompt.indexOf("## Context Snapshot"));
  assert.ok(prompt.indexOf("## Context Snapshot") < prompt.indexOf("## Inlined Context"));
});

test("Context Mode resume injection: missing snapshot does not add an empty block", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);

  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);

  assert.match(prompt, /## Context Mode/);
  assert.doesNotMatch(prompt, /## Context Snapshot/);
});

test("Context Mode resume injection: disabled mode suppresses guidance and snapshot reads", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ncontext_mode:\n  enabled: false\n---\n", "utf-8");
  writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nDo not inject.\n", "utf-8");

  const prompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);

  assert.doesNotMatch(prompt, /## Context Mode/);
  assert.doesNotMatch(prompt, /## Context Snapshot/);
  assert.doesNotMatch(prompt, /Do not inject/);
});

test("Context Mode resume injection: none-mode units do not inject snapshots", async () => {
  const base = makeFixtureBase();
  try {
    writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nNo lane.\n", "utf-8");
    const prompt = await buildWorkflowPreferencesPrompt(base);
    assert.doesNotMatch(prompt, /## Context Mode/);
    assert.doesNotMatch(prompt, /## Context Snapshot/);
    assert.doesNotMatch(prompt, /No lane/);
  } finally {
    cleanup(base);
  }
});

test("Context Mode prompt suppression: disabled inlined, phase-anchor, and nested prompts omit Context Mode", async (t) => {
  const base = makeFixtureBase();
  t.after(() => cleanup(base));
  invalidateAllCaches();

  seed(base, "M001");
  writeArtifacts(base);
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ncontext_mode:\n  enabled: false\n---\n", "utf-8");
  writeFileSync(join(base, ".gsd", "last-snapshot.md"), "# GSD context snapshot\n\nDo not inject.\n", "utf-8");

  const inlinedPrompt = await buildReassessRoadmapPrompt("M001", "Test", "S01", base);
  assert.doesNotMatch(inlinedPrompt, /## Context Mode|Context Mode \(|## Context Snapshot/);

  const phaseAnchorPrompt = await buildExecuteTaskPrompt("M001", "S01", "First", "T01", "Task", base);
  assert.doesNotMatch(phaseAnchorPrompt, /## Context Mode|Context Mode \(|## Context Snapshot/);

  const nestedPrompt = await buildGateEvaluatePrompt("M001", "Test", "S01", "First", base);
  assert.match(nestedPrompt, /Use this as the prompt for a `subagent` call/);
  assert.doesNotMatch(nestedPrompt, /## Context Mode|Context Mode \(|## Context Snapshot/);
});

// ─── v2 surface (#4924) ───────────────────────────────────────────────────

const fakeBase: BaseResolverContext = {
  unitType: "reassess-roadmap",
  basePath: process.env.GSD_TEST_WORKSPACE_ROOT ?? process.cwd(),
  milestoneId: "M001",
  sliceId: "S01",
};

test("#4924 v2 composer: returns empty sections for unknown unit type", async () => {
  const out = await composeUnitContext("never-dispatched", { base: fakeBase });
  assert.deepEqual(out, { prepend: "", inline: "" });
});

test("Unit Context Contract composer exposes keyed blocks and on-demand artifacts", async () => {
  const result = compileUnitContextContract("execute-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const calls: ArtifactKey[] = [];
  const out = await composeContractedUnitContext(result.contract, {
    base: { ...fakeBase, unitType: "stale-unit", taskId: "T01" },
    resolveArtifact: async (key) => {
      calls.push(key);
      return `BODY:${key}`;
    },
  });

  assert.deepEqual(calls, [
    "task-plan",
    "slice-plan",
    "prior-task-summaries",
    "templates",
  ]);
  assert.deepEqual(out.blocks.map((block) => [block.key, block.mode]), [
    ["task-plan", "inline"],
    ["slice-plan", "inline"],
    ["prior-task-summaries", "inline"],
    ["templates", "inline"],
  ]);
  assert.deepEqual(out.onDemand, ["slice-research"]);
  assert.match(out.inline, /BODY:task-plan\n\n---\n\nBODY:slice-plan/);
});

test("#4924 v2 composer: omitting resolveArtifact skips inline keys without erroring", async () => {
  const out = await composeUnitContext("reassess-roadmap", { base: fakeBase });
  assert.strictEqual(out.inline, "");
  assert.strictEqual(out.prepend, "");
});

test("#4924 v2 composer: walks inline + excerpt + computed sections in declared order", async () => {
  // Run-uat now keeps the UAT body inline and moves slice summary to excerpt
  // context, so verify both resolver lanes preserve manifest order.
  const calls: string[] = [];
  const resolveArtifact: ArtifactResolver = async (key) => {
    calls.push(`art:${key}`);
    return `BODY:${key}`;
  };
  const resolveExcerpt: ExcerptResolver = async (key) => {
    calls.push(`excerpt:${key}`);
    return `EXCERPT:${key}`;
  };
  const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" }, resolveArtifact, resolveExcerpt });
  assert.deepEqual(calls, ["art:slice-uat", "excerpt:slice-summary"]);
  assert.match(out.inline, /BODY:slice-uat\n\n---\n\nEXCERPT:slice-summary/);
});

test("#4924 v2 composer: excerpt section calls resolveExcerpt for declared keys", async () => {
  // complete-milestone declares slice-summary as excerpt — perfect target.
  const inlineCalls: ArtifactKey[] = [];
  const excerptCalls: ArtifactKey[] = [];
  const resolveArtifact: ArtifactResolver = async (key) => {
    inlineCalls.push(key);
    return `INLINE:${key}`;
  };
  const resolveExcerpt: ExcerptResolver = async (key) => {
    excerptCalls.push(key);
    return `EXCERPT:${key}`;
  };
  const out = await composeUnitContext("complete-milestone", {
    base: { ...fakeBase, unitType: "complete-milestone" },
    resolveArtifact,
    resolveExcerpt,
  });
  assert.ok(excerptCalls.includes("slice-summary"));
  // Excerpt body appears in the composed inline section, after inline keys.
  assert.match(out.inline, /EXCERPT:slice-summary/);
  // The inline keys come first per the manifest order.
  const cmManifest = UNIT_MANIFESTS["complete-milestone"];
  const firstInlineKey = cmManifest.artifacts.inline[0]!;
  const firstInlineIdx = out.inline.indexOf(`INLINE:${firstInlineKey}`);
  const excerptIdx = out.inline.indexOf("EXCERPT:slice-summary");
  assert.ok(firstInlineIdx >= 0 && excerptIdx > firstInlineIdx, "inline body should precede excerpt body");
});

test("#4924 v2 composer: prepend block is separate from inline section", async () => {
  // No production manifest declares a prepend block yet (those land with
  // each batched migration). Drive the composer through a synthetic
  // manifest by patching UNIT_MANIFESTS just for this test.
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner"] as never[], // computed id not in production registry — typed via cast for the test
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    const computed = {
      "test-banner": {
        build: async (_inputs: never, base: BaseResolverContext) => `BANNER for ${base.unitType}`,
        inputs: undefined as never,
      },
    } as unknown as ComputedArtifactRegistry;
    const out = await composeUnitContext("run-uat", {
      base: { ...fakeBase, unitType: "run-uat" },
      computed,
    });
    assert.strictEqual(out.prepend, "BANNER for run-uat");
    assert.strictEqual(out.inline, "");
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});

test("#4924 v2 composer: missing computed registry entry is skipped silently", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner"] as never[],
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    // No `computed` registry supplied — declared id should be skipped, not throw.
    const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" } });
    assert.strictEqual(out.prepend, "");
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});

test("#4924 v2 composer: computed builder returning null omits the section (no empty separator)", async () => {
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner-a", "test-banner-b"] as never[],
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    const computed = {
      "test-banner-a": { build: async () => null, inputs: undefined as never },
      "test-banner-b": { build: async () => "B", inputs: undefined as never },
    } as unknown as ComputedArtifactRegistry;
    const out = await composeUnitContext("run-uat", { base: { ...fakeBase, unitType: "run-uat" }, computed });
    assert.strictEqual(out.prepend, "B");
    assert.ok(!out.prepend.includes("---"));
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});

test("#4924 v2 composer: backward-compat — composeInlinedContext still works for v1 callers", async () => {
  const out = await composeInlinedContext("run-uat", async (key) => `BODY:${key}`);
  assert.strictEqual(out, "BODY:slice-uat");
});

test("#4926 review: computed builders see normalized base.unitType matching the resolved manifest", async () => {
  // Caller passes one unitType to composeUnitContext but a different (stale)
  // value in opts.base. Composer must normalize so builders observe the
  // unitType the manifest was resolved against — preventing manifests and
  // computed context from drifting.
  const original = UNIT_MANIFESTS["run-uat"];
  type Mutable<T> = { -readonly [P in keyof T]: T[P] };
  const patched: UnitContextManifest = {
    ...original,
    prepend: ["test-banner"] as never[],
  };
  (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = patched;
  try {
    let observedUnitType: string | undefined;
    const computed = {
      "test-banner": {
        build: async (_inputs: never, base: BaseResolverContext) => {
          observedUnitType = base.unitType;
          return `BANNER for ${base.unitType}`;
        },
        inputs: undefined as never,
      },
    } as unknown as ComputedArtifactRegistry;
    const out = await composeUnitContext("run-uat", {
      // Deliberately mismatched: function arg "run-uat" vs. base.unitType "stale-other-unit".
      base: { ...fakeBase, unitType: "stale-other-unit" },
      computed,
    });
    assert.strictEqual(observedUnitType, "run-uat", "builder must see the unitType the manifest was resolved against");
    assert.strictEqual(out.prepend, "BANNER for run-uat");
  } finally {
    (UNIT_MANIFESTS as Mutable<typeof UNIT_MANIFESTS>)["run-uat"] = original;
  }
});
