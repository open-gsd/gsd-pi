/**
 * tool-param-optionality — Verifies that enrichment/metadata parameters on
 * planning and completion tools are optional, not required.
 *
 * Models with limited tool-calling capability (e.g. kimi-k2.5, glm-5-turbo)
 * cannot reliably populate 20+ top-level parameters in a single tool call.
 * This test ensures that only the core identification and content parameters
 * are required, while enrichment arrays (patterns, requirements, files, etc.)
 * are optional — so any model can call the tool successfully.
 *
 * See: https://github.com/open-gsd/gsd-pi/issues/2771
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_SAVE_CONTENT_MAX_LENGTH } from "@opengsd/contracts";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import AjvModule from "ajv";

const Ajv = (AjvModule as any).default || AjvModule;

// ─── Mock PI ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

const pi = makeMockPi();
registerDbTools(pi);

function getTool(name: string) {
  return pi.tools.find((t: any) => t.name === name);
}

// ─── Helper: count required top-level properties ─────────────────────────────

function getRequiredProps(tool: any): string[] {
  const schema = tool.parameters;
  return schema.required ?? [];
}

function getOptionalProps(tool: any): string[] {
  const schema = tool.parameters;
  const allProps = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return allProps.filter((p: string) => !required.has(p));
}

function validateSchema(tool: any, value: unknown): string[] {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(tool.parameters);
  return validate(value) ? [] : (validate.errors ?? []).map((e: any) => `${e.instancePath || "/"}: ${e.message}`);
}

// ─── gsd_summary_save: OpenAI requires top-level object schema ──────────────

test("gsd_summary_save — parameters are a top-level object schema", () => {
  const tool = getTool("gsd_summary_save");
  assert.ok(tool, "gsd_summary_save must be registered");

  assert.strictEqual(tool.parameters.type, "object", "OpenAI function parameters require a top-level object schema");
  assert.ok(!("anyOf" in tool.parameters), "top-level anyOf is rejected by OpenAI function schema validation");

  const required = new Set(getRequiredProps(tool));
  assert.ok(required.has("artifact_type"), "artifact_type must be required");
  assert.ok(required.has("content"), "content must be required");
  assert.ok(!required.has("milestone_id"), "milestone_id must remain optional for root artifacts");
});

test("gsd_summary_save — validates UAT assessment params", () => {
  const tool = getTool("gsd_summary_save");
  assert.ok(tool, "gsd_summary_save must be registered");

  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(tool.parameters);
  const valid = validate({
    milestone_id: "M001",
    slice_id: "S01",
    artifact_type: "ASSESSMENT",
    content: "---\nverdict: PASS\n---\n# UAT Assessment\n",
  });

  assert.strictEqual(valid, true, `UAT assessment params should validate but got errors: ${JSON.stringify(validate.errors)}`);
});

test("gsd_summary_save — content has a provider-safe maxLength", () => {
  const tool = getTool("gsd_summary_save");
  assert.ok(tool, "gsd_summary_save must be registered");

  const contentSchema = tool.parameters.properties.content;
  assert.strictEqual(contentSchema.maxLength, SUMMARY_SAVE_CONTENT_MAX_LENGTH);

  const validAtLimit = validateSchema(tool, {
    milestone_id: "M001",
    artifact_type: "CONTEXT-DRAFT",
    content: "x".repeat(SUMMARY_SAVE_CONTENT_MAX_LENGTH),
  });
  assert.deepEqual(validAtLimit, []);

  const overLimit = validateSchema(tool, {
    milestone_id: "M001",
    artifact_type: "CONTEXT-DRAFT",
    content: "x".repeat(SUMMARY_SAVE_CONTENT_MAX_LENGTH + 1),
  });
  assert.ok(
    overLimit.some((error) => error.includes(`must NOT have more than ${SUMMARY_SAVE_CONTENT_MAX_LENGTH} characters`)),
    `expected maxLength validation error, got: ${overLimit.join("; ")}`,
  );
});

test("gsd_validate_milestone — validates complete structured verification evidence", () => {
  const tool = getTool("gsd_validate_milestone");
  assert.ok(tool, "gsd_validate_milestone must be registered");
  assert.ok(
    tool.parameters.properties.verificationEvidence,
    "validation schema must advertise structured verification evidence",
  );

  const base = {
    milestoneId: "M001",
    verdict: "pass",
    remediationRound: 0,
    successCriteriaChecklist: "- [x] Complete",
    sliceDeliveryAudit: "| S01 | pass |",
    crossSliceIntegration: "Passed",
    requirementCoverage: "Covered",
    verdictRationale: "Structured evidence passed.",
  };
  const evidence = {
    verificationClass: "UAT",
    evidenceClass: "browser",
    rationale: "The browser journey passed.",
    commandOrTool: "gsd-browser",
    workingDirectory: "/workspace",
    startedAt: "2026-07-14T12:00:00.000Z",
    endedAt: "2026-07-14T12:01:00.000Z",
    observation: "passed",
    durableOutputRef: "artifact://uat/browser-run",
    testedSourceRevision: "sha256:tested-source",
    environment: { browser: "chromium" },
  };

  assert.deepEqual(validateSchema(tool, { ...base, verificationEvidence: [evidence] }), []);
  assert.ok(
    validateSchema(tool, {
      ...base,
      verificationEvidence: [{ ...evidence, testedSourceRevision: undefined }],
    }).some((error) => error.includes("testedSourceRevision")),
    "testedSourceRevision must be required for every evidence item",
  );
});

test("milestone subjective UAT tools keep user identity out of model arguments", () => {
  const prepare = getTool("gsd_prepare_milestone_subjective_uat");
  const answer = getTool("gsd_answer_milestone_subjective_uat");
  assert.ok(prepare, "subjective UAT preparation must be registered");
  assert.ok(answer, "subjective UAT answer callback must be registered");
  assert.equal(answer.parameters.properties.actorId, undefined);
  assert.equal(answer.parameters.properties.actorType, undefined);
  assert.ok(answer.parameters.properties.selectedOptionId);
  assert.ok(answer.parameters.properties.verbatimResponse);
});

// ─── gsd_slice_complete: enrichment arrays must be optional ──────────────────

test("gsd_slice_complete — enrichment arrays are optional", () => {
  const tool = getTool("gsd_slice_complete");
  assert.ok(tool, "gsd_slice_complete must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core identification and content fields MUST be required
  const coreRequired = [
    "sliceId",
    "milestoneId",
    "sliceTitle",
    "oneLiner",
    "narrative",
    "uatContent",
  ];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // verification is intentionally optional — models that omit it avoid -32602;
  // the summary records verification as passed without detail in that case.
  assert.ok(
    !required.has("verification"),
    "verification must be optional — omitting it avoids -32602; summary records verification as passed without detail",
  );

  // Enrichment/metadata arrays MUST be optional
  const enrichmentFields = [
    "keyFiles",
    "keyDecisions",
    "patternsEstablished",
    "observabilitySurfaces",
    "provides",
    "requirementsSurfaced",
    "drillDownPaths",
    "affects",
    "requirementsAdvanced",
    "requirementsValidated",
    "requirementsInvalidated",
    "filesModified",
    "requires",
    "deviations",
    "knownLimitations",
    "followUps",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_slice_complete — validates with only core params", () => {
  const tool = getTool("gsd_slice_complete");
  assert.ok(tool, "gsd_slice_complete must be registered");

  const minimalParams = {
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Test slice",
    oneLiner: "Did the thing",
    narrative: "We did it step by step.",
    verification: "Tests pass.",
    uatContent: "## UAT\n- [x] Works",
  };

  // Should pass schema validation with only core params
  const errors = validateSchema(tool, minimalParams);
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.join(", ")}`);
});

// ─── gsd_plan_milestone: enrichment arrays must be optional ──────────────────

test("gsd_plan_milestone — promptGuidelines warn against slice-only args", () => {
  const tool = getTool("gsd_plan_milestone");
  assert.ok(tool, "gsd_plan_milestone must be registered");
  const joined = tool.promptGuidelines.join(" ");
  assert.match(joined, /milestoneId, title, vision, and slices/);
  assert.match(joined, /never pass only milestoneId \+ sliceId/i);
  assert.match(joined, /gsd_plan_slice/);
});

test("gsd_plan_milestone — enrichment arrays are optional", () => {
  const tool = getTool("gsd_plan_milestone");
  assert.ok(tool, "gsd_plan_milestone must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = ["milestoneId", "title", "vision", "slices"];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields must be optional
  const enrichmentFields = [
    "successCriteria",
    "keyRisks",
    "proofStrategy",
    "verificationContract",
    "verificationIntegration",
    "verificationOperational",
    "verificationUat",
    "definitionOfDone",
    "requirementCoverage",
    "boundaryMapMarkdown",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_plan_milestone — validates with only core params", () => {
  const tool = getTool("gsd_plan_milestone");
  assert.ok(tool, "gsd_plan_milestone must be registered");

  const minimalParams = {
    milestoneId: "M001",
    title: "Test milestone",
    vision: "Build the thing.",
    slices: [
      {
        sliceId: "S01",
        title: "First slice",
        risk: "Low",
        depends: [],
        demo: "After this, X works",
        goal: "Set up X",
        successCriteria: "X is set up",
        proofLevel: "unit-tests",
        integrationClosure: "N/A",
        observabilityImpact: "None",
      },
    ],
  };

  const errors = validateSchema(tool, minimalParams);
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.join(", ")}`);
});

// ─── gsd_task_complete: enrichment arrays must be optional ───────────────────

test("gsd_task_complete — enrichment arrays are optional", () => {
  const tool = getTool("gsd_task_complete");
  assert.ok(tool, "gsd_task_complete must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = [
    "taskId",
    "sliceId",
    "milestoneId",
    "oneLiner",
    "narrative",
  ];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  assert.ok(
    !required.has("verification"),
    "verification must be optional at the schema layer so step-mode can recover when verificationEvidence is present",
  );

  // Enrichment fields must be optional
  const enrichmentFields = [
    "keyFiles",
    "keyDecisions",
    "deviations",
    "knownIssues",
    "blockerDiscovered",
    "verificationEvidence",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_task_complete — validates with only core params", () => {
  const tool = getTool("gsd_task_complete");
  assert.ok(tool, "gsd_task_complete must be registered");

  const minimalParams = {
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    oneLiner: "Implemented the feature",
    narrative: "Created the module and wired it up.",
    verification: "npm test passes.",
  };

  const errors = validateSchema(tool, minimalParams);
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.join(", ")}`);
});

test("gsd_task_complete — accepts evidence-only verification at schema layer", () => {
  const tool = getTool("gsd_task_complete");
  assert.ok(tool, "gsd_task_complete must be registered");

  const params = {
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    oneLiner: "Implemented the feature",
    narrative: "Created the module and wired it up.",
    verificationEvidence: [
      { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 },
    ],
  };

  const errors = validateSchema(tool, params);
  assert.strictEqual(errors.length, 0, `Evidence-only params should validate but got errors: ${errors.join(", ")}`);
});

// ─── gsd_complete_milestone: enrichment arrays must be optional ──────────────

test("gsd_complete_milestone — enrichment arrays are optional", () => {
  const tool = getTool("gsd_complete_milestone");
  assert.ok(tool, "gsd_complete_milestone must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = [
    "milestoneId",
    "title",
    "oneLiner",
    "narrative",
    "verificationPassed",
  ];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields must be optional
  const enrichmentFields = [
    "successCriteriaResults",
    "definitionOfDoneResults",
    "requirementOutcomes",
    "keyDecisions",
    "keyFiles",
    "lessonsLearned",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_complete_milestone — validates with only core params", () => {
  const tool = getTool("gsd_complete_milestone");
  assert.ok(tool, "gsd_complete_milestone must be registered");

  const minimalParams = {
    milestoneId: "M001",
    title: "Test milestone",
    oneLiner: "Finished it.",
    narrative: "All work completed.",
    verificationPassed: true,
  };

  const errors = validateSchema(tool, minimalParams);
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.join(", ")}`);
});

// ─── gsd_plan_slice: enrichment fields must be optional ──────────────────────

test("gsd_plan_slice — enrichment fields are optional", () => {
  const tool = getTool("gsd_plan_slice");
  assert.ok(tool, "gsd_plan_slice must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields. `tasks` is intentionally NOT here: incremental planning
  // (#1027) lets gsd_plan_slice persist slice metadata only, then add tasks
  // one at a time via gsd_plan_task, so tasks must be optional.
  const coreRequired = ["milestoneId", "sliceId", "goal"];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields (plus tasks, optional for incremental planning).
  const enrichmentFields = [
    "tasks",
    "successCriteria",
    "proofLevel",
    "integrationClosure",
    "observabilityImpact",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_plan_slice — validates with only core params", () => {
  const tool = getTool("gsd_plan_slice");
  assert.ok(tool, "gsd_plan_slice must be registered");

  const minimalParams = {
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Implement feature X",
    tasks: [
      {
        taskId: "T01",
        title: "Build X",
        description: "Build the thing",
        estimate: "2h",
        files: ["src/x.ts"],
        verify: "npm test",
        inputs: [],
        expectedOutput: ["src/x.ts"],
        requiredWorkflowTools: [],
      },
    ],
  };

  const errors = validateSchema(tool, minimalParams);
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.join(", ")}`);
});

// ─── Required param count ceiling ────────────────────────────────────────────

test("no planning/completion tool requires more than 10 top-level params", () => {
  const heavyTools = [
    "gsd_slice_complete",
    "gsd_plan_milestone",
    "gsd_task_complete",
    "gsd_complete_milestone",
    "gsd_plan_slice",
  ];

  for (const name of heavyTools) {
    const tool = getTool(name);
    assert.ok(tool, `${name} must be registered`);
    const required = getRequiredProps(tool);
    assert.ok(
      required.length <= 10,
      `${name} has ${required.length} required params (max 10) — required: ${required.join(", ")}`,
    );
  }
});
