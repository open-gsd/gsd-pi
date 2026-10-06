// Project/App: gsd-pi
// File Purpose: The status tool that the workflow protocol and skills name must be callable on every scoped tool surface that shows them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DISCUSS_TOOLS_ALLOWLIST } from "../constants.ts";
import {
  buildMinimalGsdToolSet,
  MINIMAL_AUTO_BASE_TOOL_NAMES,
  scopeGsdWorkflowToolsForDispatch,
} from "../bootstrap/register-hooks.ts";
import { resolveVisibleSkillNames } from "../skill-scope.ts";
import { UNIT_REGISTRY } from "../unit-registry.ts";
import { buildWorkflowDispatchContent } from "../workflow-protocol.ts";
import { WORKFLOW_TOOL_SURFACE_NAMES } from "../workflow-tool-surface.ts";

const resourcesDir = join(process.cwd(), "src/resources");
const workflowPath = join(resourcesDir, "GSD-WORKFLOW.md");

/** The DB status reader. The protocol and skills send the agent here, not to STATE.md. */
const STATUS_TOOL = "gsd_project_snapshot";

const REGISTERED_TOOL_NAMES = [...MINIMAL_AUTO_BASE_TOOL_NAMES, ...WORKFLOW_TOOL_SURFACE_NAMES];

const UNIT_TYPES = Object.keys(UNIT_REGISTRY);

/**
 * The tools that the model sees after the scoping that guided-flow.ts and
 * commands-handlers.ts apply before they send the workflow protocol.
 */
function scopedToolsForDispatch(unitType?: string): string[] {
  let activeTools = [...REGISTERED_TOOL_NAMES];
  if (unitType?.startsWith("discuss-")) {
    activeTools = activeTools.filter(
      (toolName) => !toolName.startsWith("gsd_") || DISCUSS_TOOLS_ALLOWLIST.includes(toolName),
    );
  }
  scopeGsdWorkflowToolsForDispatch({
    getActiveTools: () => activeTools,
    setActiveTools: (tools) => {
      activeTools = tools;
    },
  }, unitType);
  return activeTools;
}

function gsdToolsNamedIn(text: string): string[] {
  return [...new Set(text.match(/\bgsd_[a-z_]+\b/g) ?? [])];
}

test("every GSD tool in the dispatched workflow protocol is on the scoped tool surface", () => {
  const content = buildWorkflowDispatchContent({
    workflow: readFileSync(workflowPath, "utf-8"),
    workflowPath,
    task: "Run the selected unit.",
  });
  const namedTools = gsdToolsNamedIn(content);
  assert.ok(
    namedTools.includes(STATUS_TOOL),
    `the protocol must send status reads to ${STATUS_TOOL}; it names ${namedTools.join(", ") || "no GSD tool"}`,
  );

  // run-uat is dispatched only by auto-mode with its own prompt; it never gets the protocol.
  const dispatchTypes = [undefined, ...UNIT_TYPES.filter((unitType) => unitType !== "run-uat")];
  for (const unitType of dispatchTypes) {
    const scoped = scopedToolsForDispatch(unitType);
    for (const toolName of namedTools) {
      assert.ok(
        scoped.includes(toolName),
        `protocol names ${toolName}, but the ${unitType ?? "no-unit"} dispatch surface is ${scoped.join(", ")}`,
      );
    }
  }
});

for (const skillName of ["handoff", "write-milestone-brief"]) {
  test(`${skillName} skill: ${STATUS_TOOL} is callable wherever the skill is visible`, () => {
    assert.ok(
      buildMinimalGsdToolSet(REGISTERED_TOOL_NAMES).includes(STATUS_TOOL),
      "plain interactive chat surface",
    );
    for (const unitType of UNIT_TYPES) {
      const visibleSkills = resolveVisibleSkillNames(unitType);
      if (visibleSkills && !visibleSkills.includes(skillName)) continue;
      assert.ok(
        scopedToolsForDispatch(unitType).includes(STATUS_TOOL),
        `${skillName} is visible in ${unitType}, but ${STATUS_TOOL} is not on its tool surface`,
      );
    }
  });
}
