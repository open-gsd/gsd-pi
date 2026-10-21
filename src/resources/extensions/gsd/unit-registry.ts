// Project/App: gsd-pi
// File Purpose: Unit Registry — the single declaration point for what a Unit type is (ADR-033).
//
// One Unit Descriptor per Unit type. The previously independent tables —
// `KNOWN_UNIT_TYPES`/`UnitType` (unit-context-manifest.ts), `UNIT_TOOL_CONTRACTS`
// (unit-tool-contracts.ts), the scope-class Sets (auto-unit-tool-scope.ts), and
// the unit→phase switch (preferences-models.ts) — are derived views over this
// registry. Import paths stay stable: each former home re-exports its view
// (the `gsd-db.ts` barrel discipline).
//
// Behaviour-neutral by construction. The registry preserves the asymmetries the
// old tables had drifted into, explicitly instead of accidentally:
//   - `discuss-slice` and `execute-task-simple` had tool contracts and scope-Set
//     membership but were absent from `KNOWN_UNIT_TYPES` → declared here as
//     `kind: "variant"` (excluded from the derived `KNOWN_UNIT_TYPES`/`UnitType`).
//   - `triage-captures` and `quick-task` had manifests but no tool contract and
//     no phase routing → `toolContract: null`, `phaseChain: null`.
// The parity test (tests/unit-registry.test.ts) pins every derived view to the
// pre-registry values.
//
// Not yet declared here (remaining ADR-033 steps): the manifest data
// (`UNIT_MANIFESTS` stays in unit-context-manifest.ts, already type-enforced
// against the registry's `UnitType`). Prompt-template association is declared
// for direct one-template units and verified conditional template sets;
// composition logic stays with prompt builders.

import type { CanonicalWorkflowToolName } from "@opengsd/contracts";
import { BROWSER_CONTRACT_TOOL_NAMES } from "../shared/browser-contract.js";
import type { GSDModelPhaseKey } from "./preferences-types.js";
import type { WorkflowMcpAdapterToolName } from "./workflow-tool-surface.js";

// ─── Declaration vocabulary ───────────────────────────────────────────────

/** Workflow-surface names a Unit contract may reference. Drift from WORKFLOW_TOOL_CONTRACTS fails typecheck. */
export type UnitWorkflowToolName = CanonicalWorkflowToolName | WorkflowMcpAdapterToolName;

export type UnitGsdToolName = UnitWorkflowToolName | "subagent";

export interface UnitToolSurfaceContract {
  allowedGsdTools: readonly UnitGsdToolName[];
  requiredWorkflowTools: readonly UnitWorkflowToolName[];
  forbiddenGsdTools?: Readonly<Record<string, string>>;
}

/**
 * Scope class drives the tool-scoping Sets:
 *   - "execute-task"  — source-writing execution units; members of both the
 *                       execute-task Set and the section-close gate Set.
 *   - "section-close" — units that close quality gates by writing summary
 *                       sections (gsd_save_gate_result is soft-blocked).
 *   - "standard"      — everything else.
 */
export type UnitScopeClass = "execute-task" | "section-close" | "standard";

export interface UnitDescriptor {
  /** "variant" types are dispatchable but excluded from KNOWN_UNIT_TYPES/UnitType. */
  readonly kind: "primary" | "variant";
  readonly scopeClass: UnitScopeClass;
  /**
   * Ordered phase-bucket fallback chain for model/thinking resolution
   * (ADR-026), most-specific first. `null` = no phase routing (the unit
   * resolves against session defaults).
   */
  readonly phaseChain: readonly GSDModelPhaseKey[] | null;
  /**
   * Prompt template id passed to loadPrompt for units with a direct
   * one-template builder. Omitted for conditional, composite, or not-yet
   * verified prompt associations.
   */
  readonly promptTemplate?: string;
  /**
   * Prompt template ids a conditional or composite builder may choose from.
   * Omitted unless every listed association is verified against the builder.
   */
  readonly promptTemplates?: readonly string[];
  /** `null` = the unit has no scoped gsd-tool contract. */
  readonly toolContract: UnitToolSurfaceContract | null;
}

// ─── Shared tool-name constants (used by registry rows) ──────────────────

export const RUN_UAT_WORKFLOW_TOOL_NAMES = [
  "gsd_uat_exec",
  "gsd_uat_result_save",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_journal_query",
] as const;

export const RUN_UAT_READ_ONLY_TOOL_NAMES = [
  "find",
  "glob",
  "grep",
  "ls",
  "read",
] as const;

/**
 * Browser tools presented to run-uat. A derived view of the Browser Automation
 * Contract vocabulary (shared/browser-contract.ts) — the contract module is the
 * only place browser tool names are declared.
 */
export const RUN_UAT_BROWSER_TOOL_NAMES = BROWSER_CONTRACT_TOOL_NAMES;

// ─── The registry ─────────────────────────────────────────────────────────

export const UNIT_REGISTRY = {
  "research-milestone": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["research"],
    promptTemplate: "research-milestone",
    toolContract: {
      allowedGsdTools: [
        "gsd_summary_save",
        "gsd_decision_save",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
      ],
      requiredWorkflowTools: ["gsd_summary_save"],
    },
  },
  "plan-milestone": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["planning"],
    promptTemplate: "plan-milestone",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_plan_milestone",
        "gsd_plan_slice",
        "gsd_plan_task",
        "gsd_decision_save",
        "gsd_requirement_update",
      ],
      requiredWorkflowTools: ["gsd_milestone_status", "gsd_plan_milestone", "gsd_plan_slice", "gsd_plan_task"],
    },
  },
  "discuss-milestone": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["discuss", "planning"],
    promptTemplates: ["discuss", "discuss-headless", "guided-discuss-milestone"],
    toolContract: {
      allowedGsdTools: [
        "gsd_summary_save",
        "gsd_decision_save",
        "gsd_requirement_save",
        "gsd_requirement_update",
        "gsd_plan_milestone",
        "gsd_milestone_generate_id",
      ],
      requiredWorkflowTools: [
        "ask_user_questions",
        "gsd_summary_save",
        "gsd_requirement_save",
        "gsd_requirement_update",
        "gsd_plan_milestone",
        "gsd_milestone_generate_id",
      ],
    },
  },
  "discuss-slice": {
    kind: "variant",
    scopeClass: "standard",
    phaseChain: ["discuss", "planning"],
    toolContract: {
      allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
      requiredWorkflowTools: ["ask_user_questions", "gsd_summary_save"],
    },
  },
  "validate-milestone": {
    kind: "primary",
    scopeClass: "section-close",
    phaseChain: ["validation", "planning"],
    promptTemplate: "validate-milestone",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_validate_milestone",
        "gsd_reassess_roadmap",
        "subagent",
      ],
      requiredWorkflowTools: ["gsd_milestone_status", "gsd_validate_milestone", "gsd_reassess_roadmap"],
    },
  },
  "complete-milestone": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["completion"],
    promptTemplate: "complete-milestone",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_requirement_update",
        "gsd_summary_save",
        "gsd_complete_milestone",
        "subagent",
      ],
      requiredWorkflowTools: [
        "gsd_milestone_status",
        "gsd_requirement_update",
        "gsd_summary_save",
        "gsd_complete_milestone",
      ],
    },
  },
  "research-slice": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["research"],
    promptTemplate: "research-slice",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_summary_save",
        "gsd_decision_save",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
      ],
      requiredWorkflowTools: ["gsd_summary_save"],
    },
  },
  "plan-slice": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["planning"],
    promptTemplate: "plan-slice",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_plan_slice",
        "gsd_plan_task",
        "gsd_reassess_roadmap",
        "gsd_decision_save",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
      ],
      requiredWorkflowTools: ["gsd_plan_slice", "gsd_plan_task", "gsd_reassess_roadmap"],
    },
  },
  "refine-slice": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["planning"],
    promptTemplate: "refine-slice",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_plan_slice",
        "gsd_decision_save",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
      ],
      requiredWorkflowTools: ["gsd_plan_slice"],
    },
  },
  "replan-slice": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["planning"],
    promptTemplate: "replan-slice",
    toolContract: {
      allowedGsdTools: ["gsd_replan_slice", "gsd_decision_save"],
      requiredWorkflowTools: ["gsd_replan_slice"],
    },
  },
  "complete-slice": {
    kind: "primary",
    scopeClass: "section-close",
    phaseChain: ["completion"],
    promptTemplate: "complete-slice",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_journal_query",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_slice_complete",
        "gsd_slice_reopen",
        "gsd_task_reopen",
        "gsd_task_complete",
        "gsd_replan_slice",
        "gsd_replan_task",
        "gsd_rework_brief_save",
        "gsd_decision_save",
        "gsd_capture_thought",
        "gsd_requirement_update",
        "gsd_summary_save",
        "subagent",
      ],
      requiredWorkflowTools: [
        "gsd_milestone_status",
        "gsd_exec",
        "gsd_capture_thought",
        "gsd_slice_complete",
        "gsd_task_reopen",
        "gsd_replan_slice",
        "gsd_replan_task",
        "gsd_rework_brief_save",
        "gsd_requirement_update",
        "gsd_summary_save",
      ],
      forbiddenGsdTools: {
        gsd_uat_result_save: "Run UAT owns persisted UAT Assessment.",
      },
    },
  },
  "reassess-roadmap": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["validation", "planning"],
    promptTemplate: "reassess-roadmap",
    toolContract: {
      allowedGsdTools: ["gsd_milestone_status", "gsd_reassess_roadmap"],
      requiredWorkflowTools: ["gsd_milestone_status", "gsd_reassess_roadmap"],
    },
  },
  "execute-task": {
    kind: "primary",
    scopeClass: "execute-task",
    phaseChain: ["execution"],
    promptTemplate: "execute-task",
    toolContract: {
      allowedGsdTools: [
        "gsd_task_complete",
        "gsd_task_recovery_resume",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_capture_thought",
        "gsd_decision_save",
      ],
      requiredWorkflowTools: [
        "gsd_task_complete",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_capture_thought",
      ],
    },
  },
  "replan-task": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["planning"],
    promptTemplate: "replan-task",
    toolContract: {
      allowedGsdTools: ["gsd_replan_task", "gsd_decision_save"],
      requiredWorkflowTools: ["gsd_replan_task"],
    },
  },
  "execute-task-simple": {
    kind: "variant",
    scopeClass: "execute-task",
    phaseChain: ["execution_simple", "execution"],
    toolContract: {
      allowedGsdTools: [
        "gsd_task_complete",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_capture_thought",
        "gsd_decision_save",
      ],
      requiredWorkflowTools: [
        "gsd_task_complete",
        "gsd_exec",
        "gsd_exec_search",
        "gsd_resume",
        "gsd_capture_thought",
      ],
    },
  },
  "reactive-execute": {
    kind: "primary",
    scopeClass: "execute-task",
    phaseChain: ["execution"],
    promptTemplate: "reactive-execute",
    toolContract: {
      allowedGsdTools: [
        "gsd_milestone_status",
        "gsd_task_complete",
        "gsd_exec",
        "gsd_summary_save",
        "gsd_decision_save",
      ],
      requiredWorkflowTools: ["gsd_task_complete", "gsd_summary_save"],
    },
  },
  "run-uat": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["uat", "completion"],
    promptTemplate: "run-uat",
    toolContract: {
      allowedGsdTools: [...RUN_UAT_WORKFLOW_TOOL_NAMES, "subagent"],
      requiredWorkflowTools: [...RUN_UAT_WORKFLOW_TOOL_NAMES],
      forbiddenGsdTools: {
        gsd_exec: "Use gsd_uat_exec so acceptance evidence is typed as UAT-owned.",
        gsd_save_gate_result: "gsd_uat_result_save owns the aggregate UAT gate.",
        gsd_summary_save: "gsd_uat_result_save owns persisted UAT Assessment writes.",
      },
    },
  },
  "gate-evaluate": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["validation", "planning"],
    promptTemplate: "gate-evaluate",
    toolContract: {
      allowedGsdTools: ["gsd_save_gate_result"],
      requiredWorkflowTools: ["gsd_save_gate_result"],
    },
  },
  "rewrite-docs": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["validation", "planning"],
    promptTemplate: "rewrite-docs",
    toolContract: {
      allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
      requiredWorkflowTools: [],
    },
  },
  // Sidecar units (triage, quick-task) — manifests exist, but no scoped tool
  // contract and no phase routing (today's behaviour, preserved explicitly).
  "triage-captures": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: null,
    toolContract: null,
  },
  "quick-task": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: null,
    toolContract: null,
  },
  // Deep planning mode (project-level) units
  "workflow-preferences": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["discuss", "planning"],
    promptTemplate: "guided-workflow-preferences",
    toolContract: {
      allowedGsdTools: ["gsd_summary_save"],
      requiredWorkflowTools: [],
    },
  },
  "discuss-project": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["discuss", "planning"],
    promptTemplate: "guided-discuss-project",
    toolContract: {
      allowedGsdTools: ["gsd_summary_save", "gsd_decision_save", "gsd_requirement_save"],
      requiredWorkflowTools: ["ask_user_questions", "gsd_summary_save"],
    },
  },
  "discuss-requirements": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["discuss", "planning"],
    promptTemplate: "guided-discuss-requirements",
    toolContract: {
      allowedGsdTools: ["gsd_requirement_save", "gsd_summary_save"],
      requiredWorkflowTools: ["ask_user_questions", "gsd_requirement_save", "gsd_summary_save"],
    },
  },
  "research-decision": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["discuss", "planning"],
    promptTemplate: "guided-research-decision",
    toolContract: {
      allowedGsdTools: ["gsd_summary_save"],
      requiredWorkflowTools: ["ask_user_questions"],
    },
  },
  // research-project dispatches 4 parallel scout subagents (Task calls); each scout
  // writes one file under .gsd/research/ directly. The parent coordinator does not
  // call gsd_summary_save or gsd_decision_save — the scouts own their own output.
  "research-project": {
    kind: "primary",
    scopeClass: "standard",
    phaseChain: ["research"],
    promptTemplate: "guided-research-project",
    toolContract: {
      allowedGsdTools: [],
      requiredWorkflowTools: [],
    },
  },
} as const satisfies Record<string, UnitDescriptor>;

// ─── Derived types and views ──────────────────────────────────────────────

/** Every dispatchable unit type, including variants. */
export type UnitTypeOrVariant = keyof typeof UNIT_REGISTRY;

type PrimaryUnitKeys = {
  [K in UnitTypeOrVariant]: (typeof UNIT_REGISTRY)[K]["kind"] extends "primary" ? K : never;
}[UnitTypeOrVariant];

/**
 * The manifest-strict unit-type union — every type with a `UNIT_MANIFESTS`
 * entry. Variants are excluded, exactly as the old hand-maintained
 * `KNOWN_UNIT_TYPES` excluded them.
 */
export type UnitType = PrimaryUnitKeys;

const ALL_UNIT_KEYS = Object.keys(UNIT_REGISTRY) as UnitTypeOrVariant[];

export const KNOWN_UNIT_TYPES: readonly UnitType[] = Object.freeze(
  ALL_UNIT_KEYS.filter((t): t is UnitType => UNIT_REGISTRY[t].kind === "primary"),
);

export const EXECUTE_TASK_UNIT_TYPES: ReadonlySet<string> = new Set(
  ALL_UNIT_KEYS.filter((t) => UNIT_REGISTRY[t].scopeClass === "execute-task"),
);

// Execute-task units close gates via summary sections too, so the section-close
// gate Set is every non-"standard" scope class.
export const SECTION_CLOSE_GATE_UNIT_TYPES: ReadonlySet<string> = new Set(
  ALL_UNIT_KEYS.filter((t) => UNIT_REGISTRY[t].scopeClass !== "standard"),
);

export function getUnitDescriptor(unitType: string): UnitDescriptor | undefined {
  return (UNIT_REGISTRY as Record<string, UnitDescriptor>)[unitType];
}

/** Phase-bucket fallback chain for a unit type, or null when the registry has no routing for it. */
export function getUnitPhaseChain(unitType: string): readonly GSDModelPhaseKey[] | null {
  return getUnitDescriptor(unitType)?.phaseChain ?? null;
}

/** Prompt template id for units with a direct one-template builder. */
export function getUnitPromptTemplate(unitType: string): string | undefined {
  return getUnitDescriptor(unitType)?.promptTemplate;
}

/** Prompt template ids for any verified direct or conditional prompt builder. */
export function getUnitPromptTemplates(unitType: string): readonly string[] {
  const descriptor = getUnitDescriptor(unitType);
  if (!descriptor) return [];
  if (descriptor.promptTemplates) return descriptor.promptTemplates;
  return descriptor.promptTemplate ? [descriptor.promptTemplate] : [];
}
