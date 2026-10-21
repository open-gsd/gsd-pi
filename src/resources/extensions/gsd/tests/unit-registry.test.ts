// gsd-pi — ADR-033 Unit Registry parity guard.
//
// Pins every view derived from UNIT_REGISTRY to the exact values the
// hand-maintained tables held before the registry existed. A failure here
// means a registry edit changed a derived surface — intended changes update
// the pinned expectation in the same diff.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_UNIT_TYPES,
  UNIT_REGISTRY,
  EXECUTE_TASK_UNIT_TYPES,
  SECTION_CLOSE_GATE_UNIT_TYPES,
  getUnitDescriptor,
  getUnitPhaseChain,
  getUnitPromptTemplate,
  getUnitPromptTemplates,
} from "../unit-registry.ts";
import {
  AUTO_UNIT_SCOPED_TOOLS,
  UNIT_TOOL_CONTRACTS,
  getUnitToolSurfaceContract,
} from "../unit-tool-contracts.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { UNIT_MANIFESTS } from "../unit-context-manifest.ts";
import { phaseChainForUnit } from "../preferences-models.ts";

// ─── Pinned pre-registry values ───────────────────────────────────────────

const EXPECTED_KNOWN_UNIT_TYPES = [
  "research-milestone",
  "plan-milestone",
  "discuss-milestone",
  "validate-milestone",
  "complete-milestone",
  "research-slice",
  "plan-slice",
  "refine-slice",
  "replan-slice",
  "complete-slice",
  "reassess-roadmap",
  "execute-task",
  "replan-task",
  "reactive-execute",
  "run-uat",
  "gate-evaluate",
  "rewrite-docs",
  "triage-captures",
  "quick-task",
  "workflow-preferences",
  "discuss-project",
  "discuss-requirements",
  "research-decision",
  "research-project",
];

// The contract table carried two keys KNOWN_UNIT_TYPES never had (variants)
// and lacked two it did have (sidecars without contracts).
const EXPECTED_CONTRACT_ONLY_TYPES = ["discuss-slice", "execute-task-simple"];
const EXPECTED_CONTRACT_LESS_TYPES = ["triage-captures", "quick-task"];

const EXPECTED_EXECUTE_TASK_SET = ["execute-task", "execute-task-simple", "reactive-execute"];
const EXPECTED_SECTION_CLOSE_SET = [
  ...EXPECTED_EXECUTE_TASK_SET,
  "complete-slice",
  "validate-milestone",
];

const EXPECTED_PHASE_CHAINS: Record<string, string[] | undefined> = {
  "research-milestone": ["research"],
  "research-slice": ["research"],
  "research-project": ["research"],
  "plan-milestone": ["planning"],
  "plan-slice": ["planning"],
  "refine-slice": ["planning"],
  "replan-slice": ["planning"],
  "replan-task": ["planning"],
  "discuss-milestone": ["discuss", "planning"],
  "discuss-slice": ["discuss", "planning"],
  "discuss-project": ["discuss", "planning"],
  "discuss-requirements": ["discuss", "planning"],
  "workflow-preferences": ["discuss", "planning"],
  "research-decision": ["discuss", "planning"],
  "execute-task": ["execution"],
  "reactive-execute": ["execution"],
  "execute-task-simple": ["execution_simple", "execution"],
  "complete-slice": ["completion"],
  "complete-milestone": ["completion"],
  "worktree-merge": ["completion"],
  "run-uat": ["uat", "completion"],
  "reassess-roadmap": ["validation", "planning"],
  "rewrite-docs": ["validation", "planning"],
  "gate-evaluate": ["validation", "planning"],
  "validate-milestone": ["validation", "planning"],
  "triage-captures": undefined,
  "quick-task": undefined,
  subagent: ["subagent"],
  "subagent/scout": ["subagent"],
  "no-such-unit": undefined,
};

const EXPECTED_DIRECT_PROMPT_TEMPLATES: Record<string, string> = {
  "research-milestone": "research-milestone",
  "plan-milestone": "plan-milestone",
  "validate-milestone": "validate-milestone",
  "complete-milestone": "complete-milestone",
  "research-slice": "research-slice",
  "plan-slice": "plan-slice",
  "refine-slice": "refine-slice",
  "replan-slice": "replan-slice",
  "complete-slice": "complete-slice",
  "reassess-roadmap": "reassess-roadmap",
  "execute-task": "execute-task",
  "replan-task": "replan-task",
  "reactive-execute": "reactive-execute",
  "run-uat": "run-uat",
  "gate-evaluate": "gate-evaluate",
  "rewrite-docs": "rewrite-docs",
  "workflow-preferences": "guided-workflow-preferences",
  "discuss-project": "guided-discuss-project",
  "discuss-requirements": "guided-discuss-requirements",
  "research-decision": "guided-research-decision",
  "research-project": "guided-research-project",
};

const EXPECTED_UNDECLARED_PROMPT_TEMPLATE_TYPES = [
  "discuss-slice",
  "execute-task-simple",
  "triage-captures",
  "quick-task",
];

const EXPECTED_CONDITIONAL_PROMPT_TEMPLATES: Record<string, string[]> = {
  "discuss-milestone": ["discuss", "discuss-headless", "guided-discuss-milestone"],
};

// ─── Derived-view parity ──────────────────────────────────────────────────

test("KNOWN_UNIT_TYPES derives exactly the pre-registry list, in order", () => {
  assert.deepEqual([...KNOWN_UNIT_TYPES], EXPECTED_KNOWN_UNIT_TYPES);
});

test("UNIT_TOOL_CONTRACTS keeps the pre-registry key set, asymmetries included", () => {
  const contractKeys = Object.keys(UNIT_TOOL_CONTRACTS);
  for (const variant of EXPECTED_CONTRACT_ONLY_TYPES) {
    assert.ok(contractKeys.includes(variant), `variant ${variant} must keep its contract`);
    assert.ok(!KNOWN_UNIT_TYPES.includes(variant as never), `${variant} must stay out of KNOWN_UNIT_TYPES`);
  }
  for (const sidecar of EXPECTED_CONTRACT_LESS_TYPES) {
    assert.ok(!contractKeys.includes(sidecar), `${sidecar} must stay contract-less`);
    assert.equal(getUnitToolSurfaceContract(sidecar), undefined);
  }
  const expectedKeys = [
    ...EXPECTED_KNOWN_UNIT_TYPES.filter((t) => !EXPECTED_CONTRACT_LESS_TYPES.includes(t)),
    ...EXPECTED_CONTRACT_ONLY_TYPES,
  ].sort();
  assert.deepEqual([...contractKeys].sort(), expectedKeys);
});

test("scope-class Sets match the pre-registry hand-maintained Sets", () => {
  assert.deepEqual([...EXECUTE_TASK_UNIT_TYPES].sort(), [...EXPECTED_EXECUTE_TASK_SET].sort());
  assert.deepEqual([...SECTION_CLOSE_GATE_UNIT_TYPES].sort(), [...EXPECTED_SECTION_CLOSE_SET].sort());
});

test("phaseChainForUnit matches the pre-registry switch for every known input", () => {
  for (const [unitType, expected] of Object.entries(EXPECTED_PHASE_CHAINS)) {
    assert.deepEqual(
      phaseChainForUnit(unitType),
      expected,
      `phase chain for ${unitType}`,
    );
  }
});

test("direct prompt-template associations live on the Unit Registry", () => {
  for (const [unitType, promptTemplate] of Object.entries(EXPECTED_DIRECT_PROMPT_TEMPLATES)) {
    assert.equal(
      getUnitPromptTemplate(unitType),
      promptTemplate,
      `prompt template for ${unitType}`,
    );
    assert.ok(
      existsSync(join(process.cwd(), "src/resources/extensions/gsd/prompts", `${promptTemplate}.md`)),
      `prompt template file must exist for ${unitType}: ${promptTemplate}`,
    );
  }

  for (const unitType of EXPECTED_UNDECLARED_PROMPT_TEMPLATE_TYPES) {
    assert.equal(
      getUnitPromptTemplate(unitType),
      undefined,
      `${unitType} prompt association is conditional or not verified yet`,
    );
  }
});

test("conditional prompt-template associations live on the Unit Registry without pretending to be direct", () => {
  for (const [unitType, promptTemplates] of Object.entries(EXPECTED_CONDITIONAL_PROMPT_TEMPLATES)) {
    assert.equal(
      getUnitPromptTemplate(unitType),
      undefined,
      `${unitType} must not expose a single direct prompt template`,
    );
    assert.deepEqual(
      getUnitPromptTemplates(unitType),
      promptTemplates,
      `prompt templates for ${unitType}`,
    );
    for (const promptTemplate of promptTemplates) {
      assert.ok(
        existsSync(join(process.cwd(), "src/resources/extensions/gsd/prompts", `${promptTemplate}.md`)),
        `prompt template file must exist for ${unitType}: ${promptTemplate}`,
      );
    }
  }
});

test("AUTO_UNIT_SCOPED_TOOLS mirrors each contract's allowed tools", () => {
  for (const [unitType, contract] of Object.entries(UNIT_TOOL_CONTRACTS)) {
    assert.deepEqual(AUTO_UNIT_SCOPED_TOOLS[unitType], contract.allowedGsdTools);
  }
  assert.deepEqual(
    Object.keys(AUTO_UNIT_SCOPED_TOOLS).sort(),
    Object.keys(UNIT_TOOL_CONTRACTS).sort(),
  );
});

// ─── Registry-internal coherence ──────────────────────────────────────────

test("every primary unit type has a manifest; manifests cover nothing else", () => {
  const manifestKeys = Object.keys(UNIT_MANIFESTS).sort();
  assert.deepEqual(manifestKeys, [...KNOWN_UNIT_TYPES].sort());
});

test("every registry row is reachable through the descriptor accessor", () => {
  for (const unitType of Object.keys(UNIT_REGISTRY)) {
    const descriptor = getUnitDescriptor(unitType);
    assert.ok(descriptor, `descriptor for ${unitType}`);
    assert.ok(["primary", "variant"].includes(descriptor.kind));
    assert.ok(["execute-task", "section-close", "standard"].includes(descriptor.scopeClass));
    assert.equal(getUnitPhaseChain(unitType), descriptor.phaseChain);
  }
  assert.equal(getUnitDescriptor("no-such-unit"), undefined);
});

test("complete-slice can settle Waiver rejections without SUMMARY fallback (#1796)", () => {
  const completeSlice = getUnitToolSurfaceContract("complete-slice")?.allowedGsdTools ?? [];
  const executeTask = getUnitToolSurfaceContract("execute-task")?.allowedGsdTools ?? [];
  const waiverSettlementTools = ["gsd_slice_reopen", "gsd_task_complete", "gsd_journal_query"] as const;

  for (const tool of waiverSettlementTools) {
    assert.ok(
      completeSlice.includes(tool),
      `complete-slice allowedGsdTools must include ${tool}`,
    );
    assert.equal(
      shouldBlockAutoUnitToolCall("complete-slice", tool).block,
      false,
      `complete-slice must not HARD BLOCK ${tool}`,
    );
  }

  assert.ok(!executeTask.includes("gsd_slice_reopen"), "execute-task must not gain gsd_slice_reopen");
  assert.ok(!executeTask.includes("gsd_journal_query"), "execute-task must not gain gsd_journal_query");
});
