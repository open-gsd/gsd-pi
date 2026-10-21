import { parseUnitId } from "./unit-id.js";
import {
  AUTO_UNIT_SCOPED_TOOLS,
  getForbiddenGsdToolReason,
} from "./unit-tool-contracts.js";
import {
  WORKFLOW_TOOL_ALIAS_PAIRS,
  isWorkflowSurfaceAliasTool,
  stripMcpToolPrefix,
} from "./workflow-tool-surface.js";
import { canonicalWorkflowToolName } from "./engine-hook-contract.js";

export {
  AUTO_UNIT_SCOPED_TOOLS,
  RUN_UAT_BROWSER_TOOL_NAMES,
} from "./unit-tool-contracts.js";

// Scope-class membership is declared per unit in the Unit Registry (ADR-033).
// EXECUTE_TASK_UNIT_TYPES = scopeClass "execute-task"; the section-close gate
// Set additionally includes scopeClass "section-close" — units whose completion
// handlers persist gate verdicts from artifact sections (gsd_save_gate_result
// belongs to gate-evaluate, so it is soft-blocked with a redirect below).
import {
  EXECUTE_TASK_UNIT_TYPES,
  SECTION_CLOSE_GATE_UNIT_TYPES,
} from "./unit-registry.js";

const EXTRA_SCOPED_GSD_LIFECYCLE_TOOLS = [
  "gsd_skip_slice",
  "gsd_task_recovery_resume",
  "gsd_slice_reopen",
  "gsd_milestone_reopen",
] as const;

const SCOPED_GSD_LIFECYCLE_TOOLS = new Set(
  [
    ...Object.values(AUTO_UNIT_SCOPED_TOOLS).flat(),
    ...WORKFLOW_TOOL_ALIAS_PAIRS.map(({ canonical }) => canonical),
    ...EXTRA_SCOPED_GSD_LIFECYCLE_TOOLS,
  ]
    .filter((tool) => tool.startsWith("gsd_"))
    .map(canonicalWorkflowToolName),
);

export const GSD_PHASE_SCOPE_DISPLAY_REASON = "This GSD phase only allows its scoped workflow tools.";
export const GSD_SECTION_CLOSE_GATE_DISPLAY_REASON =
  "Gates here close by writing summary sections — gsd_save_gate_result isn't needed.";

type AutoUnitToolScopeResult = {
  block: boolean;
  reason?: string;
  displayReason?: string;
};

// Normalizer seam lives in engine-hook-contract.ts; re-exported here for
// existing scope importers.
export { canonicalWorkflowToolName };

export function isWorkflowAliasTool(toolName: string): boolean {
  return isWorkflowSurfaceAliasTool(toolName);
}

function hardBlockReason(unitType: string, what: string): string {
  return [
    `HARD BLOCK: Tool Contract failure for unit "${unitType}" — ${what}.`,
    "This is a mechanical phase-boundary gate. You MUST NOT proceed, retry the same call,",
    "or route around this block; the orchestrator owns phase transitions.",
  ].join(" ");
}

function hardBlock(unitType: string, what: string): AutoUnitToolScopeResult {
  return {
    block: true,
    reason: hardBlockReason(unitType, what),
    displayReason: GSD_PHASE_SCOPE_DISPLAY_REASON,
  };
}

// This stable marker is registered in auto-tool-tracking.ts so auto-mode treats
// the redirect as deterministic policy, not a retryable execution failure.
function softGateToolRedirect(unitType: string): AutoUnitToolScopeResult {
  return {
    block: true,
    reason: [
      `Skip this call — the "${unitType}" phase closes its quality gates by writing summary sections,`,
      "not by calling gsd_save_gate_result (that tool belongs to the gate-evaluate phase).",
      "Record each gate by filling its named section in your summary: a populated section records `pass`,",
      "an empty one records `omitted`. Then call your completion tool and the handler persists every verdict.",
      "This is expected, not an error — continue without gsd_save_gate_result.",
    ].join(" "),
    displayReason: GSD_SECTION_CLOSE_GATE_DISPLAY_REASON,
  };
}

function allowedGsdToolsForUnit(unitType: string): string[] {
  return [...new Set(
    (AUTO_UNIT_SCOPED_TOOLS[unitType] ?? [])
      .filter((tool) => tool.startsWith("gsd_"))
      .map(canonicalWorkflowToolName),
  )].sort();
}

function isNativeWorkflowTool(toolName: string): boolean {
  return stripMcpToolPrefix(toolName) === "Workflow";
}

export function readStringField(input: unknown, camel: string, snake: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record[camel] ?? record[snake];
  return typeof value === "string" ? value : undefined;
}

function shouldBlockTaskCompletionScope(
  unitType: string,
  unitId: string | undefined,
  toolName: string,
  input: unknown,
): AutoUnitToolScopeResult {
  if (!EXECUTE_TASK_UNIT_TYPES.has(unitType)) return { block: false };
  if (canonicalWorkflowToolName(toolName) !== "gsd_task_complete") return { block: false };
  if (!unitId) return { block: false };

  const expected = parseUnitId(unitId);
  if (!expected.milestone || !expected.slice || !expected.task) return { block: false };

  const actualMilestone = readStringField(input, "milestoneId", "milestone_id");
  const actualSlice = readStringField(input, "sliceId", "slice_id");
  const actualTask = readStringField(input, "taskId", "task_id");

  if (!actualMilestone || !actualSlice || !actualTask) return { block: false };
  if (
    actualMilestone === expected.milestone &&
    actualSlice === expected.slice &&
    actualTask === expected.task
  ) {
    return { block: false };
  }

  return hardBlock(
    unitType,
    `gsd_task_complete may only complete the active task ${expected.milestone}/${expected.slice}/${expected.task}; requested ${actualMilestone}/${actualSlice}/${actualTask}`,
  );
}

export function shouldBlockAutoUnitToolCall(
  unitType: string,
  toolName: string,
  input?: unknown,
  unitId?: string,
): AutoUnitToolScopeResult {
  const scopedTools = AUTO_UNIT_SCOPED_TOOLS[unitType];
  if (!scopedTools) return { block: false };

  if (isNativeWorkflowTool(toolName)) {
    return hardBlock(unitType, "native Workflow is not permitted inside a dispatched GSD auto-mode unit");
  }

  const taskScope = shouldBlockTaskCompletionScope(unitType, unitId, toolName, input);
  if (taskScope.block) return taskScope;

  const canonicalTool = canonicalWorkflowToolName(toolName);
  if (!SCOPED_GSD_LIFECYCLE_TOOLS.has(canonicalTool)) return { block: false };

  const allowedTools = allowedGsdToolsForUnit(unitType);
  if (allowedTools.includes(canonicalTool)) return { block: false };

  const forbiddenReason = getForbiddenGsdToolReason(unitType, canonicalTool);
  if (forbiddenReason) {
    return hardBlock(
      unitType,
      `GSD lifecycle tool "${canonicalTool}" is not permitted; ${forbiddenReason} Fix unit-tool-contracts.ts or the ${unitType} prompt.`,
    );
  }

  if (canonicalTool === "gsd_save_gate_result" && SECTION_CLOSE_GATE_UNIT_TYPES.has(unitType)) {
    return softGateToolRedirect(unitType);
  }

  return hardBlock(
    unitType,
    `GSD lifecycle tool "${canonicalTool}" is not permitted; allowed GSD tools: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(none)"}`,
  );
}
