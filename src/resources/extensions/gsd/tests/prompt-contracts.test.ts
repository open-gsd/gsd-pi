import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUN_UAT_BROWSER_TOOL_NAMES,
  resolveToolPresentationPlan,
  buildRunUatResultPresentation,
  buildRunUatPresentationForType,
  RUN_UAT_READ_ONLY_TOOL_NAMES,
  RUN_UAT_TOOL_PRESENTATION_PLAN_ID,
  RUN_UAT_WORKFLOW_TOOL_NAMES,
} from "../tool-presentation-plan.ts";
import {
  buildMinimalAutoGsdToolSet,
  MINIMAL_AUTO_BASE_TOOL_NAMES,
  MINIMAL_GSD_TOOL_NAMES,
} from "../bootstrap/register-hooks.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { UNIT_TOOL_CONTRACTS } from "../unit-tool-contracts.ts";
import { uatTypeIncludesBrowser } from "../uat-policy.ts";

const promptsDir = join(process.cwd(), "src/resources/extensions/gsd/prompts");
const templatesDir = join(process.cwd(), "src/resources/extensions/gsd/templates");

function readPrompt(name: string): string {
  return readFileSync(join(promptsDir, `${name}.md`), "utf-8");
}

function readTemplate(name: string): string {
  return readFileSync(join(templatesDir, `${name}.md`), "utf-8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const registeredPhaseToolNames = [
  ...new Set([
    ...MINIMAL_AUTO_BASE_TOOL_NAMES,
    ...MINIMAL_GSD_TOOL_NAMES,
    ...Object.values(UNIT_TOOL_CONTRACTS).flatMap((contract) => contract.allowedGsdTools),
  ]),
];

const PHASE_PROMPT_TOOL_CALLS: Record<string, readonly string[]> = {
  "research-milestone": ["gsd_summary_save"],
  "plan-milestone": [
    "gsd_milestone_status",
    "gsd_plan_milestone",
    "gsd_plan_slice",
    "gsd_decision_save",
  ],
  "research-slice": ["gsd_summary_save"],
  "plan-slice": ["gsd_reassess_roadmap", "gsd_plan_slice", "gsd_decision_save", "capture_thought"],
  "refine-slice": ["gsd_plan_slice", "gsd_decision_save"],
  "replan-slice": ["gsd_replan_slice"],
  "execute-task": [
    "gsd_task_complete",
    "gsd_exec",
    "gsd_exec_search",
    "gsd_resume",
    "gsd_capture_thought",
  ],
  "reactive-execute": ["gsd_summary_save"],
  "complete-slice": [
    "gsd_exec",
    "gsd_task_reopen",
    "gsd_replan_slice",
    "gsd_requirement_update",
    "gsd_capture_thought",
    "gsd_slice_complete",
    "gsd_summary_save",
  ],
  "reassess-roadmap": ["gsd_milestone_status", "gsd_reassess_roadmap"],
  "validate-milestone": ["gsd_milestone_status", "gsd_validate_milestone", "gsd_reassess_roadmap"],
  "run-uat": ["gsd_uat_exec", "gsd_uat_result_save"],
  "gate-evaluate": ["gsd_save_gate_result"],
  "complete-milestone": [
    "gsd_milestone_status",
    "gsd_requirement_update",
    "gsd_summary_save",
    "capture_thought",
    "gsd_complete_milestone",
  ],
};

test("auto phase prompt tool calls are available in scoped tool surfaces", () => {
  for (const [unitType, promptTools] of Object.entries(PHASE_PROMPT_TOOL_CALLS)) {
    const prompt = readPrompt(unitType);
    const activeTools = buildMinimalAutoGsdToolSet(
      registeredPhaseToolNames,
      unitType,
      registeredPhaseToolNames,
    );

    for (const toolName of promptTools) {
      assert.match(
        prompt,
        new RegExp(`\\b${escapeRegExp(toolName)}\\b`),
        `${unitType} prompt should mention ${toolName}`,
      );
      assert.ok(
        activeTools.includes(toolName),
        `${unitType} prompt mentions ${toolName}, but scoped tools are ${activeTools.join(", ")}`,
      );

      const scopeResult = shouldBlockAutoUnitToolCall(unitType, toolName);
      assert.equal(
        scopeResult.block,
        false,
        `${unitType} phase gate blocked ${toolName}: ${scopeResult.reason ?? "unknown reason"}`,
      );
    }
  }
});

test("reactive-execute prompt keeps task summaries with subagents and avoids batch commits", () => {
  const prompt = readPrompt("reactive-execute");
  assert.match(prompt, /subagent-written summary as authoritative/i);
  assert.match(prompt, /Do NOT create a batch commit/i);
  assert.match(prompt, /cwd:\s*"\{\{workingDirectory\}\}"/);
  assert.doesNotMatch(prompt, /\*\*Write task summaries\*\*/i);
  assert.doesNotMatch(prompt, /\*\*Commit\*\* all changes/i);
});

test("run-uat prompt branches on dynamic UAT mode and supports runtime evidence", () => {
  const prompt = readPrompt("run-uat");
  assert.match(prompt, /\*\*Detected UAT mode:\*\*\s*`\{\{uatType\}\}`/);
  assert.match(prompt, /uatType:\s*"\{\{uatType\}\}"/);
  assert.match(prompt, /gsd_uat_result_save/);
  assert.match(prompt, /presentedTools/);
  assert.match(prompt, /\{\{canonicalPresentation\}\}/);
  assert.match(prompt, /live-runtime/);
  assert.match(prompt, /browser\/runtime\/network/i);
  assert.match(prompt, /NEEDS-HUMAN/);
  assert.match(prompt, /out-of-surface-tool/);
  assert.doesNotMatch(prompt, /uatType:\s*artifact-driven/);
  assert.doesNotMatch(prompt, /Call `gsd_summary_save`/);
});

test("run-uat prompt lists canonical gsd_uat_exec intent values", () => {
  const prompt = readPrompt("run-uat");
  assert.match(prompt, /`uat-artifact-check`/);
  assert.match(prompt, /`uat-runtime-check`/);
  assert.match(prompt, /`uat-browser-check`/);
  assert.match(prompt, /`uat-service-start`/);
  assert.match(prompt, /`uat-log-inspection`/);
  assert.match(prompt, /do not use `artifact`, `runtime`, or `human-follow-up` as `intent`/i);
});

test("run-uat prompt documents all UAT result evidence kinds and ref rules", () => {
  const prompt = readPrompt("run-uat");
  for (const kind of ["gsd_uat_exec", "gsd_exec", "screenshot", "log", "url", "browser"] as const) {
    assert.ok(prompt.includes(`\`${kind}\``), `run-uat prompt should document evidence kind ${kind}`);
  }
  assert.match(prompt, /\.gsd\/exec\//);
  assert.match(prompt, /\.gsd\/uat\//);
  assert.match(prompt, /\.artifacts\/browser\//);
  assert.match(prompt, /http:\/\/` or `https:\/\//);
  assert.match(prompt, /`artifact`, `runtime`, `browser`, and `human-follow-up` are check `mode` values/i);
});

test("run-uat prompt gives the complete UAT result-save presentation contract", () => {
  const prompt = readPrompt("run-uat");
  assert.match(prompt, /Call `gsd_uat_result_save` once after all checks are complete/);
  assert.doesNotMatch(prompt, /Call `gsd_summary_save` with `artifact_type: "ASSESSMENT"`/);
  assert.match(prompt, /\{\{canonicalPresentation\}\}/);
  assert.match(prompt, /\{\{toolPresentationPlanId\}\}/);

  const presentation = buildRunUatResultPresentation();
  assert.equal(presentation.toolPresentationPlanId, RUN_UAT_TOOL_PRESENTATION_PLAN_ID);
  for (const toolName of RUN_UAT_WORKFLOW_TOOL_NAMES) {
    assert.ok(presentation.presentedTools.includes(toolName), `presentation should include required tool ${toolName}`);
  }
  for (const toolName of RUN_UAT_READ_ONLY_TOOL_NAMES) {
    assert.ok(presentation.presentedTools.includes(toolName), `presentation should include read-only tool ${toolName}`);
  }

  for (const toolName of ["gsd_exec", "gsd_summary_save", "gsd_save_gate_result"] as const) {
    assert.ok(
      presentation.blockedTools.some((entry) => entry.name === toolName),
      `presentation should include blocked tool ${toolName}`,
    );
  }

  assert.ok(
    presentation.blockedTools.every((entry) => entry.reason === "forbidden during run-uat"),
    "presentation should explain blocked run-uat tools",
  );
});

test("browser-executable UAT presentation uses direct browser tools", () => {
  const presentation = buildRunUatPresentationForType("browser-executable");

  assert.equal(presentation.surface, "hybrid");
  for (const toolName of RUN_UAT_BROWSER_TOOL_NAMES) {
    assert.ok(presentation.presentedTools.includes(toolName), `presentation should include browser tool ${toolName}`);
  }
  assert.ok(!presentation.presentedTools.some((toolName) => toolName.startsWith("mcp__gsd-browser__")));
});

test("run-uat presentation plans carry typed tool-surface snapshots", () => {
  const plan = resolveToolPresentationPlan({
    phase: "run-uat",
    surface: "mcp",
    workflowMcpServerName: "gsd-workflow",
    availableToolNames: [
      "gsd_uat_exec",
      "gsd_uat_result_save",
      "read",
    ],
    includeBrowserTools: [],
  });

  assert.equal(plan.toolSurface.source, "presentation-plan");
  assert.equal(plan.toolSurface.phase, "run-uat");
  assert.deepEqual(plan.toolSurface.scopedToolNames, [
    "gsd_uat_exec",
    "gsd_uat_result_save",
    "read",
  ]);
  assert.deepEqual(plan.toolSurface.presentedToolNames, [
    "mcp__gsd-workflow__gsd_uat_exec",
    "mcp__gsd-workflow__gsd_uat_result_save",
    "read",
  ]);
});

test("live-runtime and mixed UAT presentations also surface browser tools", () => {
  // Regression (M001/S03): the run-uat prompt tells live-runtime and mixed to
  // drive a browser, so the runner must actually receive the browser tools and
  // a hybrid surface — otherwise live checks silently downgrade to NEEDS-HUMAN.
  for (const uatType of ["live-runtime", "mixed", "human-experience"] as const) {
    assert.equal(uatTypeIncludesBrowser(uatType), true, `${uatType} policy should include browser tools`);
    const presentation = buildRunUatPresentationForType(uatType);
    assert.equal(presentation.surface, "hybrid", `${uatType} should use the hybrid surface`);
    for (const toolName of RUN_UAT_BROWSER_TOOL_NAMES) {
      assert.ok(
        presentation.presentedTools.includes(toolName),
        `${uatType} presentation should include browser tool ${toolName}`,
      );
    }
  }
});

test("artifact-driven and runtime-executable UAT presentations stay browser-free", () => {
  for (const uatType of ["artifact-driven", "runtime-executable"] as const) {
    assert.equal(uatTypeIncludesBrowser(uatType), false, `${uatType} policy should stay browser-free`);
    const presentation = buildRunUatPresentationForType(uatType);
    assert.equal(presentation.surface, "mcp", `${uatType} should use the mcp surface`);
    assert.ok(
      !RUN_UAT_BROWSER_TOOL_NAMES.some((toolName) => presentation.presentedTools.includes(toolName)),
      `${uatType} presentation should not include browser tools`,
    );
  }
});

test("workflow-start prompt defaults to autonomy instead of per-phase confirmation", () => {
  const prompt = readPrompt("workflow-start");
  assert.match(prompt, /Keep moving by default/i);
  assert.match(prompt, /Decision gates, not ceremony/i);
  assert.match(prompt, /Persist workflow state/i);
  assert.match(prompt, /completedAt/i);
  assert.doesNotMatch(prompt, /confirm with the user before proceeding/i);
  assert.doesNotMatch(prompt, /Gate between phases/i);
});

test("system prompt references CODEBASE.md and /gsd codebase", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /CODEBASE\.md/);
  assert.match(prompt, /\/gsd codebase \[generate\|update\|stats\]/);
  assert.match(prompt, /auto-refreshes it when tracked files change/i);
});

test("system prompt hard rules forbid fabricating user responses", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /never fabricate, simulate, or role-play user responses/i);
  assert.match(prompt, /never generate markers like `?\[User\]`?, `?\[Human\]`?, `?User:`?/i);
  assert.match(prompt, /ask one question round \(1-3 questions\), then stop and wait for the user's actual response/i);
  assert.match(prompt, /ask_user_questions.*only valid structured user input/i);
});

test("system prompt requires reading before edit or overwrite", () => {
  const prompt = readPrompt("system");
  assert.match(prompt, /Read before edit or overwrite/i);
  assert.match(prompt, /Before any write that creates or replaces a file/i);
  assert.match(prompt, /confirm whether the path exists; if it does, `read` it first/i);
  assert.match(prompt, /For truly new files, confirm the path does not already exist/i);
});

test("discuss prompt allows implementation questions when they materially matter", () => {
  const prompt = readPrompt("discuss");
  assert.match(prompt, /Lead with experience, but ask implementation when it materially matters/i);
  assert.match(prompt, /Never fabricate, simulate, or role-play user responses/i);
  assert.match(prompt, /Ask one question round \(1-3 questions\) per turn, then stop and wait for the user's actual response/i);
  assert.match(prompt, /one gate, not two/i);
  assert.doesNotMatch(prompt, /Questions must be about the experience, not the implementation/i);
});

test("discuss prompt ends milestone planning with next-step handoff", () => {
  const prompt = readPrompt("discuss");
  assert.match(prompt, /Next steps:/);
  assert.match(prompt, /\/gsd auto/);
  assert.match(prompt, /\/gsd status/);
  assert.match(prompt, /\/gsd visualize/);
  assert.match(prompt, /\/gsd notifications/);
  assert.doesNotMatch(prompt, /nothing else\. Auto-mode will start automatically/);
});

test("guided discussion prompts avoid wrap-up prompts after every round", () => {
  const milestonePrompt = readPrompt("guided-discuss-milestone");
  const slicePrompt = readPrompt("guided-discuss-slice");
  assert.match(milestonePrompt, /Do \*\*not\*\* ask a meta "ready to wrap up\?" question after every round/i);
  assert.match(slicePrompt, /Do \*\*not\*\* ask a meta "ready to wrap up\?" question after every round/i);
  assert.doesNotMatch(milestonePrompt, /I think I have a solid picture of this milestone\. Ready to wrap up/i);
  assert.doesNotMatch(slicePrompt, /I think I have a solid picture of this slice\. Ready to wrap up/i);
  assert.match(milestonePrompt, /Never fabricate or simulate user input/i);
  assert.match(slicePrompt, /Never fabricate or simulate user input/i);
});

test("guided milestone discussion scopes depth verification to the milestone id", () => {
  const prompt = readPrompt("guided-discuss-milestone");
  assert.match(prompt, /depth_verification_\{\{milestoneId\}\}/, "depth verification id should include the milestone id");
  assert.doesNotMatch(prompt, /depth_verification_confirm" — this enables the write-gate downstream/i, "legacy global depth gate wording should be gone");
});

test("guided requirements prompt requires milestone-qualified provisional owners", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  assert.match(prompt, /M###\/none yet/, "unsliced requirements should retain milestone ownership");
  assert.match(prompt, /never bare `none yet`/, "prompt should forbid bare provisional ownership");
  assert.doesNotMatch(prompt, /primary owning slice \(or `none yet`\)/i);
});

test("guided requirements prompt saves requirement records before final summary write", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  const output = prompt.slice(prompt.indexOf("## Output"));
  const requirementSaveIndex = output.indexOf("gsd_requirement_save");
  const summarySaveIndex = output.indexOf("gsd_summary_save");

  assert.ok(requirementSaveIndex >= 0, "output instructions should call gsd_requirement_save");
  assert.ok(summarySaveIndex >= 0, "output instructions should call gsd_summary_save");
  assert.ok(
    requirementSaveIndex < summarySaveIndex,
    "DB-backed requirement records should be saved before writing REQUIREMENTS.md",
  );
});

test("guided requirements prompt uses supported summary artifact types", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  assert.match(prompt, /artifact_type:\s*"REQUIREMENTS-DRAFT"/);
  assert.match(prompt, /artifact_type:\s*"REQUIREMENTS"(?!-)/);
  assert.match(prompt, /omit `milestone_id`/);
  assert.match(prompt, /Do NOT use `artifact_type: "CONTEXT"` and do NOT pass `milestone_id: "REQUIREMENTS"`/);
  assert.match(prompt, /depth_verification_requirements_confirm/);
  assert.doesNotMatch(prompt, /call `gsd_summary_save` with `artifact_type: "CONTEXT"`/);
});

test("workflow preferences prompt writes defaults without interactive questions", () => {
  const prompt = readPrompt("guided-workflow-preferences");
  assert.match(prompt, /default-writing/i);
  assert.match(prompt, /Do NOT call `ask_user_questions`/);
  assert.match(prompt, /commit_policy:\s*per-task/);
  assert.match(prompt, /branch_model:\s*single/);
  assert.match(prompt, /research:\s*skip/);
  assert.match(prompt, /"decision": "skip"/);
  assert.doesNotMatch(prompt, /research:\s*research/);
  assert.doesNotMatch(prompt, /Ask all three questions/i);
  assert.doesNotMatch(prompt, /Ask all four questions/i);
  assert.doesNotMatch(prompt, /Ask all five questions/i);
});

test("project research prompt dispatches scout agents allowed by planning-dispatch", () => {
  const prompt = readPrompt("guided-research-project");
  assert.match(prompt, /agent:\s*"\{\{scoutAgentType\}\}"/);
  assert.match(prompt, /Do not use `agent: "researcher"`/);
  assert.match(prompt, /runtime clears the dispatch marker/i);
  assert.doesNotMatch(prompt, /Delete `\.gsd\/runtime\/research-project-inflight`/);
});

test("slice planning prompts name scout for external research dispatch", () => {
  const planSlice = readPrompt("plan-slice");
  const refineSlice = readPrompt("refine-slice");
  assert.match(planSlice, /dispatch the \*\*scout\*\* agent/);
  assert.match(refineSlice, /dispatch the \*\*scout\*\* agent/);
  assert.doesNotMatch(planSlice, /dispatch the \*\*researcher\*\* agent/);
  assert.doesNotMatch(refineSlice, /dispatch the \*\*researcher\*\* agent/);
});

test("guided project prompt writes root PROJECT artifact, not PROJECT milestone", () => {
  const prompt = readPrompt("guided-discuss-project");
  assert.match(prompt, /artifact_type:\s*"PROJECT"/);
  assert.match(prompt, /omit `milestone_id`/);
  assert.match(prompt, /Do NOT use `artifact_type: "CONTEXT"` and do NOT pass `milestone_id: "PROJECT"`/);
  assert.match(prompt, /single freeform question in plain text, not structured/i);
  assert.doesNotMatch(prompt, /project_initial_shape/);
  assert.match(prompt, /depth_verification_project_confirm/);
});

test("guided research decision prompt keeps exact chat confirmation strings", () => {
  const prompt = readPrompt("guided-research-decision");
  assert.match(prompt, /^Research decision: research$/m);
  assert.match(prompt, /^Research decision recorded\.$/m);
  assert.match(prompt, /Skip \(Recommended\)/);
  assert.match(prompt, /"source": "research-decision"/);
  assert.match(prompt, /Do not change the required confirmation strings/i);
  assert.doesNotMatch(prompt, /note the inference in the chat confirmation line/i);
});

test("queue prompt requires waiting for user response between rounds", () => {
  const prompt = readPrompt("queue");
  assert.match(prompt, /Never fabricate or simulate user input during this discussion/i);
  assert.match(prompt, /Ask 1-3 questions per round, then wait for the user's response before asking the next round\./i);
  assert.doesNotMatch(prompt, /treat that as permission to continue/i);
});

test("guided-resume-task prompt preserves recovery state until work is superseded", () => {
  const prompt = readPrompt("guided-resume-task");
  assert.match(prompt, /Do \*\*not\*\* delete the continue file immediately/i);
  assert.match(prompt, /successfully completed or you have written a newer summary\/continue artifact/i);
  assert.doesNotMatch(prompt, /Delete the continue file after reading it/i);
});

// ─── Prompt migration: execute-task → gsd_complete_task ───────────────

test("execute-task prompt references gsd_task_complete tool", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /gsd_task_complete/);
});

test("execute-task prompt uses gsd_task_complete as canonical summary write path", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /\{\{taskSummaryPath\}\}/);
  assert.match(prompt, /gsd_task_complete/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{taskSummaryPath\}\}`?/i);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{taskSummaryPath\}\}`?\s*$/m);
});

test("execute-task prompt forbids phase escalation tools and native Workflow", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /Complete only `\{\{taskId\}\}`/);
  assert.match(prompt, /Do NOT call `gsd_slice_complete`, `gsd_validate_milestone`, `gsd_complete_milestone`/);
  assert.match(prompt, /spawn `Workflow`/);
  assert.match(prompt, /orchestrator owns slice\/milestone closure and phase transitions/i);
});

test("execute-task prompt does not instruct LLM to toggle checkboxes manually", () => {
  const prompt = readPrompt("execute-task");
  assert.doesNotMatch(prompt, /change \[ \] to \[x\]/);
  assert.doesNotMatch(prompt, /Mark \{\{taskId\}\} done in/);
});

test("execute-task prompt still contains template variables for context", () => {
  const prompt = readPrompt("execute-task");
  assert.match(prompt, /\{\{taskSummaryPath\}\}/);
  assert.match(prompt, /\{\{planPath\}\}/);
});

// ─── Prompt migration: complete-slice → gsd_complete_slice ────────────

test("complete-slice prompt references gsd_slice_complete tool", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /gsd_slice_complete/);
});

test("complete-slice prompt does not instruct LLM to toggle checkboxes manually", () => {
  const prompt = readPrompt("complete-slice");
  assert.doesNotMatch(prompt, /change \[ \] to \[x\]/);
});

test("complete-slice prompt keeps source fixes in execution units", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /Do not use direct `bash` for verification commands/i);
  assert.match(prompt, /do \*\*not\*\* edit source files in this unit/i);
  assert.match(prompt, /do \*\*not\*\* call `gsd_slice_complete`/i);
  assert.match(prompt, /gsd_task_reopen/);
  assert.match(prompt, /gsd_replan_slice/);
  assert.match(prompt, /needs execution follow-up/i);
  assert.doesNotMatch(prompt, /Fix failures before marking done/i);
});

test("complete-slice prompt terminates after reopen or replan handoff", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /exactly one terminal workflow tool/i);
  assert.match(prompt, /A text-only stop, even one mentioning a tool, is invalid/i);
  assert.match(prompt, /After any successful failure-handoff tool call, the unit is done/i);
  assert.match(prompt, /`gsd_task_reopen` or `gsd_replan_slice` call is the handoff signal/i);
  assert.match(prompt, /Never call `gsd_replan_slice` after calling `gsd_task_reopen`/i);
  assert.match(prompt, /reopened tasks are pending/i);
  assert.match(prompt, /Do not call `gsd_plan_slice`/i);
  assert.match(prompt, /Do not read source code, run `gsd_exec`, invoke subagents/i);
  assert.match(prompt, /Terminal reopen sequence/i);
  assert.match(prompt, /Terminal replan sequence/i);
  assert.match(prompt, /Never finish this unit with plain text only/i);
});

test("complete-slice prompt binds all file operations to workingDirectory", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /Your working directory is `\{\{workingDirectory\}\}`/);
  assert.match(prompt, /All file reads, writes, and shell commands MUST operate relative to this directory/);
});

test("complete-slice prompt disambiguates task-specific regressions from inherited failures", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /pre-task verification evidence shows it was absent before that task ran/i);
  assert.match(prompt, /failures present before the task ran/i);
});

test("complete-slice prompt instructs writing summary and UAT files before tool call", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /\{\{sliceSummaryPath\}\}/);
  assert.match(prompt, /\{\{sliceUatPath\}\}/);
  assert.match(prompt, /gsd_slice_complete/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{sliceSummaryPath\}\}`?/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{sliceUatPath\}\}`?/i);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{sliceSummaryPath\}\}`?.*$/m);
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{sliceUatPath\}\}`?.*$/m);
});

test("complete-slice prompt preserves decisions and knowledge review steps", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /DECISIONS\.md/);
  assert.match(prompt, /KNOWLEDGE\.md/);
});

test("validate-milestone prompt uses gsd_validate_milestone as canonical validation write path", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /gsd_validate_milestone/);
  assert.match(prompt, /\{\{validationPath\}\}/);
  assert.match(prompt, /DB-backed tool is the canonical write path/i);
  assert.match(prompt, /Do \*\*not\*\* manually write `?\{\{validationPath\}\}`?/i);
  assert.doesNotMatch(prompt, /Write to `?\{\{validationPath\}\}`?:/i);
});

test("complete-slice prompt still contains template variables for context", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /\{\{sliceSummaryPath\}\}/);
  assert.match(prompt, /\{\{sliceUatPath\}\}/);
});

test("plan-milestone prompt references DB-backed planning tool and explicitly forbids manual roadmap writes", () => {
  const prompt = readPrompt("plan-milestone");
  assert.match(prompt, /gsd_plan_milestone/);
  assert.match(prompt, /Do \*\*not\*\* write `?\{\{outputPath\}\}`?, `?ROADMAP\.md`?, or other planning artifacts manually/i);
  assert.match(prompt, /NEVER call `gsd_plan_milestone` with only `milestoneId` and `sliceId`/);
  assert.match(prompt, /gsd_plan_slice/);
  assert.match(prompt, /gsd_plan_task/);
});

test("discuss prompts forbid gsd_plan_milestone slice-only tool args", () => {
  for (const name of ["discuss", "discuss-headless"] as const) {
    const prompt = readPrompt(name);
    assert.match(prompt, /NEVER call `gsd_plan_milestone` with only `milestoneId` and `sliceId`/);
    assert.match(prompt, /title`, `vision`, `slices\[\]/);
  }
});

test("plan-slice prompt no longer frames direct PLAN writes as the source of truth", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /Do \*\*not\*\* rely on direct `PLAN\.md` writes as the source of truth/i);
});

test("plan-slice prompt explicitly names incremental DB-backed planning tools", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /gsd_plan_slice/);
  assert.match(prompt, /gsd_plan_task/);
  assert.match(prompt, /Persist incrementally through DB-backed tools/i);
  assert.match(prompt, /DB-backed tools are the canonical write path/i);
});

test("plan-slice prompt does not instruct direct file writes as a primary step", () => {
  const prompt = readPrompt("plan-slice");
  // Should not instruct to "Write {{outputPath}}" as a primary step — tools handle rendering
  assert.doesNotMatch(prompt, /^\d+\.\s+Write `?\{\{outputPath\}\}`?\s*$/m);
});

test("plan-slice prompt requires per-task incremental persistence", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /gsd_plan_task/);
  assert.match(prompt, /omit `tasks` for this metadata call/i);
  assert.match(prompt, /call `gsd_plan_task` once per task/i);
  assert.doesNotMatch(prompt, /do not call `gsd_plan_task`/i);
});

test("plan-slice prompt references web app UAT guidance when planning browser work", () => {
  const prompt = readPrompt("plan-slice");
  assert.match(prompt, /Web App UAT guidance/i);
  assert.match(prompt, /Playwright smoke scaffolding/i);
});

test("complete-slice prompt references web app UAT mode rules", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(prompt, /Web App UAT guidance/i);
  assert.match(prompt, /browser-executable|runtime-executable/i);
});

test("plan-milestone prompt seeds web verification strategy", () => {
  const prompt = readPrompt("plan-milestone");
  assert.match(prompt, /Web apps/i);
  assert.match(prompt, /Playwright|browser_\*/i);
});

test("replan-slice prompt uses gsd_replan_slice as canonical DB-backed tool", () => {
  const prompt = readPrompt("replan-slice");
  assert.match(prompt, /gsd_replan_slice/);
  // Degraded fallback (direct file writes) was removed — DB tools are always available
  assert.doesNotMatch(prompt, /Degraded fallback/i);
});

// ─── ADR-011 refine-slice prompt contracts ────────────────────────────

test("refine-slice prompt names gsd_plan_slice as the DB-backed write path", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(prompt, /gsd_plan_slice/, "refine-slice must call gsd_plan_slice to persist");
});

test("refine-slice prompt does not instruct direct PLAN.md writes", () => {
  const prompt = readPrompt("refine-slice");
  assert.match(
    prompt,
    /do NOT rely on direct `PLAN\.md` writes/i,
    "refine-slice must not frame direct file writes as authoritative",
  );
});

test("refine-slice prompt frames the unit as a transformation, not blank-sheet planning", () => {
  const prompt = readPrompt("refine-slice");
  // The framing language is load-bearing — the model should treat this as
  // expanding an approved sketch, not planning from scratch.
  assert.match(prompt, /expands an approved sketch/i);
  assert.match(prompt, /Sketch Scope/);
});

test("reassess-roadmap prompt references gsd_reassess_roadmap tool", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /gsd_reassess_roadmap/);
});

test("validate-milestone prompt dispatches parallel reviewers", () => {
  const prompt = readPrompt("validate-milestone");
  assert.match(prompt, /Reviewer A/);
  assert.match(prompt, /Reviewer B/);
  assert.match(prompt, /Reviewer C/);
  assert.match(prompt, /Requirements Coverage/);
  assert.match(prompt, /Cross-Slice Integration/);
  assert.match(prompt, /Assessment & Acceptance Criteria/);
  assert.match(prompt, /assessment evidence/i);
});

// ─── ADR-029: forward preloaded evidence to validate reviewers ────────
test("validate-milestone forwards preloaded evidence to reviewers and keeps full reads on-demand", () => {
  const prompt = readPrompt("validate-milestone");
  // Orchestrator is told to embed the preloaded evidence into reviewer tasks.
  assert.match(prompt, /[Ee]mbed the relevant preloaded evidence/);
  // Each reviewer is told to use the preloaded evidence, not re-read from disk.
  const useCount = (prompt.match(/do not re-read them from disk/g) ?? []).length;
  assert.ok(useCount >= 3, `expected all three reviewers to use preloaded evidence, found ${useCount}`);
  // Full reads are explicitly the on-demand exception, not the routine path.
  assert.match(prompt, /only if (its|the) preloaded (excerpt|evidence) is missing, truncated, or inconsistent/i);
});

// ─── ADR-029: research-milestone grounds instead of surveying ─────────
test("research-milestone prompt grounds in preloaded context instead of open-ended survey", () => {
  const prompt = readPrompt("research-milestone");
  // Grounded-research invariant present.
  assert.match(prompt, /do not re-survey/i);
  assert.match(prompt, /Codebase Snapshot and Project Classification/);
  // The old open-ended survey license is gone (no "use `scout` to build a broad map").
  assert.doesNotMatch(prompt, /use `scout` to build a broad map/);
  // resolve_library/docs lookups remain permitted (bounded, external).
  assert.match(prompt, /resolve_library/);
  // Incremental save enables resume after interruption.
  assert.match(prompt, /Save \*\*incrementally\*\*/);
  assert.match(prompt, /Resume — Prior Partial Research/);
});

// ─── Prompt migration: replan-slice → gsd_replan_slice ────────────────

test("replan-slice prompt names gsd_replan_slice as the tool to use", () => {
  const prompt = readPrompt("replan-slice");
  assert.match(prompt, /gsd_replan_slice/);
});

// ─── Prompt migration: reassess-roadmap → gsd_reassess_roadmap ───────

test("reassess-roadmap prompt names gsd_reassess_roadmap as the tool to use", () => {
  const prompt = readPrompt("reassess-roadmap");
  assert.match(prompt, /gsd_reassess_roadmap/);
});

// ─── Bug #2933: prompt parameter names must match camelCase TypeBox schema ───

test("execute-task prompt uses camelCase parameter names matching TypeBox schema", () => {
  const prompt = readPrompt("execute-task");
  // The gsd_complete_task tool schema uses camelCase: milestoneId, sliceId, taskId
  // Prompts must NOT tell the LLM to use snake_case (milestone_id, slice_id, task_id)
  const toolCallLine = prompt.split("\n").find((l) => /gsd_complete_task/.test(l) || /gsd_task_complete/.test(l));
  assert.ok(toolCallLine, "prompt must contain a gsd_complete_task or gsd_task_complete tool call line");
  assert.doesNotMatch(toolCallLine!, /milestone_id/, "must use milestoneId, not milestone_id");
  assert.doesNotMatch(toolCallLine!, /slice_id/, "must use sliceId, not slice_id");
  assert.doesNotMatch(toolCallLine!, /task_id/, "must use taskId, not task_id");
  // Positive: must mention the camelCase names
  assert.match(toolCallLine!, /milestoneId/);
  assert.match(toolCallLine!, /sliceId/);
  assert.match(toolCallLine!, /taskId/);
});

test("complete-slice prompt uses camelCase parameter names matching TypeBox schema", () => {
  const prompt = readPrompt("complete-slice");
  // The gsd_complete_slice tool schema uses camelCase: milestoneId, sliceId
  const toolCallLine = prompt.split("\n").find((l) =>
    (/gsd_complete_slice/.test(l) || /gsd_slice_complete/.test(l)) && /milestoneId/.test(l) && /sliceId/.test(l)
  );
  assert.ok(toolCallLine, "prompt must contain a gsd_complete_slice or gsd_slice_complete tool call line");
  assert.doesNotMatch(toolCallLine!, /milestone_id/, "must use milestoneId, not milestone_id");
  assert.doesNotMatch(toolCallLine!, /slice_id/, "must use sliceId, not slice_id");
  // Positive: must mention the camelCase names
  assert.match(toolCallLine!, /milestoneId/);
  assert.match(toolCallLine!, /sliceId/);
});

// ─── File system safety: complete-slice parity with complete-milestone (#2935) ──

test("complete-slice prompt includes filesystem safety guard against EISDIR", () => {
  const prompt = readPrompt("complete-slice");
  assert.match(
    prompt,
    /File system safety/i,
    "complete-slice.md must include a 'File system safety' instruction to prevent EISDIR errors when the LLM passes a directory path to the read tool"
  );
  assert.match(
    prompt,
    /never pass.*directory path.*directly to the.*read.*tool/i,
    "complete-slice.md must warn against passing directory paths to the read tool"
  );
});

test("complete-milestone prompt still has its filesystem safety guard (regression)", () => {
  const prompt = readPrompt("complete-milestone");
  assert.match(
    prompt,
    /File system safety/i,
    "complete-milestone.md must keep its filesystem safety guard"
  );
});

test("reactive-execute prompt references tool calls instead of checkbox updates", () => {
  const prompt = readPrompt("reactive-execute");
  assert.doesNotMatch(prompt, /checkbox updates/);
  assert.doesNotMatch(prompt, /checkbox edits/);
  assert.match(prompt, /completion tool calls/);
});

test("parallel subagent prompts forbid serialized tasks arrays", () => {
  const expectations = [
    { name: "reactive-execute", agent: "worker" },
    { name: "parallel-research-slices", agent: "\\{\\{scoutAgentType\\}\\}" },
    { name: "gate-evaluate", agent: "tester" },
  ] as const;

  for (const { name, agent } of expectations) {
    const prompt = readPrompt(name);
    assert.match(prompt, /tasks:\s*\[\.\.\.\]/, `${name} must show the native array placeholder`);
    assert.match(prompt, /native JSON array/i, `${name} must explicitly require a native JSON array`);
    assert.match(prompt, /Do NOT JSON\.stringify/i, `${name} must forbid JSON.stringify on tasks`);
    assert.match(prompt, /must be array/i, `${name} must mention the subagent validation failure`);
    assert.match(
      prompt,
      new RegExp(`tasks:\\s*\\[\\{\\s*agent:\\s*"${agent}"`, "i"),
      `${name} must show the concrete ${agent} task call shape`,
    );
  }
});

test("gate-evaluate prompt requires gate result findings field", () => {
  const prompt = readPrompt("gate-evaluate");
  assert.match(prompt, /`findings`/);
  assert.match(prompt, /empty string if none/i);
});

// ─── Project-shape classifier + 3-or-4-options-with-Other-hatch contract ──

test("guided-discuss-project classifies project shape and persists the verdict to PROJECT.md", () => {
  const prompt = readPrompt("guided-discuss-project");
  assert.match(prompt, /Classify project shape/i, "must include the classifier section");
  assert.match(prompt, /`simple`/);
  assert.match(prompt, /`complex`/);
  assert.match(prompt, /Default to `complex` when uncertain/i);
  assert.match(prompt, /## Project Shape/, "must reference the persisted PROJECT.md section");
  assert.match(prompt, /\*\*Complexity:\*\*\s*simple/);
  assert.match(prompt, /\*\*Complexity:\*\*\s*complex/);
});

test("guided-discuss prompts require 3-or-4 options plus Other-let-me-discuss in complex mode", () => {
  for (const name of [
    "guided-discuss-project",
    "guided-discuss-milestone",
    "guided-discuss-slice",
  ]) {
    const prompt = readPrompt(name);
    assert.match(
      prompt,
      /3 or 4 concrete, researched options/i,
      `${name} must require 3 or 4 grounded options in complex mode`,
    );
    assert.match(
      prompt,
      /"Other — let me discuss"/,
      `${name} must include the "Other — let me discuss" escape hatch`,
    );
    assert.match(
      prompt,
      /grounded in (the |your |)(investigation|preloaded context)/i,
      `${name} must require options grounded in the preloaded context / prior investigation`,
    );
  }
});

test("guided-discuss-requirements scopes the 3-or-4-options rule to free-form questions only", () => {
  const prompt = readPrompt("guided-discuss-requirements");
  assert.match(prompt, /3 or 4 concrete, researched options/i);
  assert.match(prompt, /"Other — let me discuss"/);
  // Class-assignment and status questions have fixed enumerations, so the rule must exempt them.
  assert.match(prompt, /class-assignment.*status.*exempt/i);
});

test("downstream discuss prompts read project shape verdict from PROJECT.md", () => {
  for (const name of [
    "guided-discuss-milestone",
    "guided-discuss-requirements",
    "guided-discuss-slice",
  ]) {
    const prompt = readPrompt(name);
    assert.match(
      prompt,
      /Project Shape/,
      `${name} must reference Project Shape from PROJECT.md`,
    );
    assert.match(
      prompt,
      /default to `complex`/i,
      `${name} must default to complex when the verdict is missing`,
    );
  }
});

test("project template includes the Project Shape section so the verdict has a home", () => {
  const template = readTemplate("project");
  assert.match(template, /## Project Shape/);
  assert.match(template, /\*\*Complexity:\*\*/);
});

// ─── Project shape verdict — end-to-end propagation contract (F7 / #5267) ──
// The verdict is propagated from discuss-project to downstream stages via
// PROJECT.md text only, with no parser. These tests pin the round-trip:
// the format the upstream stage is told to write must be discoverable by
// the regex pattern the downstream stage is told to look for.

/**
 * Render the project.md template with a concrete complexity verdict so we
 * can assert on a realistic PROJECT.md (the placeholder is filled the way
 * an LLM following the prompt would fill it).
 */
function renderProjectMd(verdict: "simple" | "complex"): string {
  return readTemplate("project")
    .replace("{{simple | complex}}", verdict)
    .replace("{{one-line rationale citing the signals that decided it}}", "Test fixture rationale.");
}

test("project shape verdict survives the discuss-project → discuss-milestone round trip", () => {
  for (const verdict of ["simple", "complex"] as const) {
    const projectMd = renderProjectMd(verdict);

    // Upstream contract: the PROJECT.md the discuss-project prompt writes
    // must contain the section header and the bolded `**Complexity:** <verdict>`
    // marker that downstream stages are told to grep for.
    assert.match(projectMd, /## Project Shape/, `rendered ${verdict} PROJECT.md must keep the section header`);
    const complexityMarker = new RegExp(`\\*\\*Complexity:\\*\\*\\s*${verdict}\\b`);
    assert.match(
      projectMd,
      complexityMarker,
      `rendered ${verdict} PROJECT.md must expose the bolded Complexity marker the downstream regex looks for`,
    );

    // Downstream contract: discuss-milestone, discuss-requirements, and
    // discuss-slice must each instruct the LLM to look at the same section
    // header AND the same `**Complexity:**` marker the template writes.
    // Without this, the upstream verdict is silently dropped.
    for (const downstream of ["guided-discuss-milestone", "guided-discuss-requirements", "guided-discuss-slice"]) {
      const prompt = readPrompt(downstream);
      assert.match(
        prompt,
        /## Project Shape/,
        `${downstream} must direct the LLM to the same section header the template writes`,
      );
      assert.match(
        prompt,
        /\*\*Complexity:\*\*/,
        `${downstream} must direct the LLM to the same **Complexity:** marker the template writes`,
      );
    }
  }
});

test("downstream discuss prompts default to complex when PROJECT.md lacks the verdict", () => {
  // Safe-by-default: if upstream omits the section (existing projects, LLM
  // drift, future template change), each downstream stage must explicitly
  // fall back to complex so behavior is conservative rather than stuck.
  for (const downstream of ["guided-discuss-milestone", "guided-discuss-requirements", "guided-discuss-slice"]) {
    const prompt = readPrompt(downstream);
    assert.match(
      prompt,
      /default to `complex`/i,
      `${downstream} must default to complex when the upstream verdict is missing`,
    );
  }
});
