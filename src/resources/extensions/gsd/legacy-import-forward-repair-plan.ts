// Project/App: gsd-pi
// File Purpose: Pure three-way Forward Repair planning for one retained Import Application.

import type { LegacyImportValue } from "./legacy-import-contract.js";
import { deepFreeze } from "./legacy-import-utils.js";
import type {
  LegacyImportApplicationPlan,
  LegacyImportApplicationPlanInstruction,
  LegacyImportApplicationRowInstruction,
} from "./legacy-import-application-plan.js";
import type {
  LegacyImportBaseRow,
  LegacyImportBaseRowSet,
  LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "./legacy-import-preview.js";

export const LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION = 2 as const;

/**
 * Why the plan is being compiled. "revert" undoes the retained Import
 * Application's changes (the recovery route's explicit undo); "retain" keeps
 * them and only forwards the receipt to the current authority head (the
 * migration publication route, which must never destroy its own migrated
 * rows). The goal changes only how intact or later-undone Application changes
 * are classified; genuine later overlaps pause for reviewed choices in both
 * modes.
 */
export type LegacyImportForwardRepairGoal = "revert" | "retain";

export type LegacyImportForwardRepairDisposition =
  | "safe-revert"
  | "already-repaired"
  | "later-modified"
  | "conflict"
  | "preserve"
  | "choice-required";

type SqlValue = null | number | string;
type SqlRecord = Readonly<Record<string, SqlValue>>;

export interface LegacyImportForwardRepairRowMutation {
  readonly action: "create" | "update" | "delete";
  readonly rowSet: LegacyImportBaseRowSet;
  readonly identity: SqlRecord;
  readonly values: SqlRecord;
}

export interface LegacyImportForwardRepairDependencyMutation {
  readonly action: "replace-slice-dependencies";
  readonly milestoneId: string;
  readonly sliceId: string;
  readonly dependsOnSliceIds: readonly string[];
}

export interface LegacyImportForwardRepairDecisionMutation {
  readonly action: "restore-decision-memory" | "delete-decision-memory";
  readonly decisionId: string;
  readonly structuredFields: string | null;
}

export interface LegacyImportForwardRepairCancelLifecycleMutation {
  readonly action: "cancel-imported-lifecycle";
  readonly itemKind: "milestone" | "slice" | "task";
  readonly milestoneId: string;
  readonly sliceId: string | null;
  readonly taskId: string | null;
  readonly expectedStatus: string;
  readonly expectedStateVersion: number;
  readonly expectedLastOperationId: string;
}

export interface LegacyImportForwardRepairCreateLifecycleMutation {
  readonly action: "create-cancelled-lifecycle";
  readonly itemKind: "milestone" | "slice";
  readonly milestoneId: string;
  readonly sliceId: string | null;
  readonly taskId: null;
}

export type LegacyImportForwardRepairMutation =
  | LegacyImportForwardRepairRowMutation
  | LegacyImportForwardRepairDependencyMutation
  | LegacyImportForwardRepairDecisionMutation
  | LegacyImportForwardRepairCancelLifecycleMutation
  | LegacyImportForwardRepairCreateLifecycleMutation;

export interface LegacyImportForwardRepairReview {
  readonly currentValue: LegacyImportValue;
  readonly proposedMutation: LegacyImportForwardRepairMutation;
  readonly recommendedDecision: "preserve-later";
  readonly recommendationRationale: string;
}

export interface LegacyImportForwardRepairTarget {
  readonly instructionIndex: number;
  readonly targetKind: string;
  readonly targetKey: string;
  readonly changeIds: readonly string[];
  readonly disposition: LegacyImportForwardRepairDisposition;
  readonly reasonCode: string;
  readonly reviewHash: string | null;
  readonly review: LegacyImportForwardRepairReview | null;
  readonly mutation: LegacyImportForwardRepairMutation | null;
}

export interface LegacyImportForwardRepairPlan {
  readonly planSchemaVersion: typeof LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION;
  readonly goal: LegacyImportForwardRepairGoal;
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly backupId: string;
  readonly differenceHash: string;
  readonly expectedProjectRevision: number;
  readonly expectedAuthorityEpoch: number;
  readonly baseRelevantRowsHash: string;
  readonly applicationRelevantRowsHash: string;
  readonly currentRelevantRowsHash: string;
  readonly targetCount: number;
  readonly mutationCount: number;
  readonly preservedCount: number;
  readonly rejectedCount: number;
  readonly unresolvedCount: number;
  readonly targets: readonly LegacyImportForwardRepairTarget[];
}

export interface LegacyImportForwardRepairChoice {
  readonly instructionIndex: number;
  readonly targetKind: string;
  readonly targetKey: string;
  readonly reviewHash: string;
  readonly decision: "preserve-later" | "restore-backup";
}

export interface LegacyImportForwardRepairPlanInput {
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly applicationRelevantRowsHash: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly backupId: string;
  readonly applicationPlan: Readonly<LegacyImportApplicationPlan>;
  readonly backupBase: Readonly<LegacyImportBaseSnapshot>;
  readonly currentBase: Readonly<LegacyImportBaseSnapshot>;
  readonly choices?: readonly Readonly<LegacyImportForwardRepairChoice>[];
  readonly goal?: LegacyImportForwardRepairGoal;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalLegacyImportJson(left as LegacyImportValue)
    === canonicalLegacyImportJson(right as LegacyImportValue);
}

function includesValues(current: Readonly<Record<string, LegacyImportValue>>, expected: SqlRecord): boolean {
  return Object.entries(expected).every(([field, value]) => sameValue(current[field], value));
}

function rowKey(rowSet: LegacyImportBaseRowSet, identity: string): string {
  return `${rowSet}\0${identity}`;
}

// Insert-time content of the snapshot columns a legacy import create does not
// write. The Import Application writer INSERTs only the columns carried by
// instruction.values (db/writers/legacy-import-application.ts), so every other
// content column takes its static schema DEFAULT (db-base-schema.ts; every
// migration ALTER ADD COLUMN uses the identical default). The base snapshot
// deliberately excludes volatile timestamps, so the exact post-import row is
// fully determined: these defaults overridden by the planned values. The
// defaults are pinned to LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION — the
// snapshot capture fails closed on any other schema version before this table
// is consulted. An entry missing here (or a schema default drifting) only ever
// classifies a created row as changed-later, never as unchanged.
const CREATED_ROW_INSERT_DEFAULTS: Readonly<Record<string, Readonly<Record<string, SqlValue>>>> = {
  milestones: {
    title: "", status: "active", depends_on: "[]", completed_at: null,
    vision: "", success_criteria: "[]", key_risks: "[]", proof_strategy: "[]",
    verification_contract: "", verification_integration: "",
    verification_operational: "", verification_uat: "", definition_of_done: "[]",
    requirement_coverage: "", boundary_map_markdown: "", sequence: 0,
  },
  slices: {
    title: "", status: "pending", risk: "medium", depends: "[]", demo: "",
    completed_at: null, full_summary_md: "", full_uat_md: "", goal: "",
    success_criteria: "", proof_level: "", integration_closure: "",
    observability_impact: "", target_repositories: "[]", sequence: 0,
    replan_triggered_at: null, is_sketch: 0, sketch_scope: "",
  },
  tasks: {
    title: "", status: "pending", one_liner: "", narrative: "",
    verification_result: "", duration: "", completed_at: null,
    blocker_discovered: 0, blocker_source: "", escalation_pending: 0,
    escalation_awaiting_review: 0, escalation_artifact_path: null,
    escalation_override_applied_at: null, deviations: "", known_issues: "",
    key_files: "[]", key_decisions: "[]", full_summary_md: "", description: "",
    estimate: "", files: "[]", verify: "", inputs: "[]", expected_output: "[]",
    observability_impact: "", full_plan_md: "", target_repositories: "[]",
    sequence: 0,
  },
  requirements: {
    class: "", status: "", description: "", why: "", source: "",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null,
  },
  artifacts: {
    artifact_type: "", milestone_id: null, slice_id: null, task_id: null,
    full_content: "", content_hash: null,
  },
  assessments: {
    status: "", full_content: "",
  },
};

function rowIndex(snapshot: Readonly<LegacyImportBaseSnapshot>): Map<string, LegacyImportBaseRow> {
  return new Map(snapshot.rows.map((row) => [rowKey(row.row_set, row.identity), row]));
}

function instructionIdentity(instruction: Extract<LegacyImportApplicationPlanInstruction, {
  action: "create" | "update" | "delete";
}>): string {
  return canonicalLegacyImportJson(instruction.identity as unknown as LegacyImportValue);
}

interface HierarchyIdentity {
  readonly itemKind: "milestone" | "slice" | "task";
  readonly milestoneId: string;
  readonly sliceId: string | null;
  readonly taskId: string | null;
}

function hierarchyIdentity(instruction: Extract<LegacyImportApplicationPlanInstruction, {
  action: "create" | "update" | "delete";
}>): HierarchyIdentity | null {
  if (instruction.targetKind === "milestone" && typeof instruction.identity["id"] === "string") {
    return {
      itemKind: "milestone",
      milestoneId: instruction.identity["id"],
      sliceId: null,
      taskId: null,
    };
  }
  if (
    instruction.targetKind === "slice"
    && typeof instruction.identity["milestone_id"] === "string"
    && typeof instruction.identity["id"] === "string"
  ) {
    return {
      itemKind: "slice",
      milestoneId: instruction.identity["milestone_id"],
      sliceId: instruction.identity["id"],
      taskId: null,
    };
  }
  if (
    instruction.targetKind === "task"
    && typeof instruction.identity["milestone_id"] === "string"
    && typeof instruction.identity["slice_id"] === "string"
    && typeof instruction.identity["id"] === "string"
  ) {
    return {
      itemKind: "task",
      milestoneId: instruction.identity["milestone_id"],
      sliceId: instruction.identity["slice_id"],
      taskId: instruction.identity["id"],
    };
  }
  return null;
}

function sameHierarchyIdentity(
  identity: Readonly<HierarchyIdentity>,
  candidate: Readonly<HierarchyIdentity>,
): boolean {
  return identity.itemKind === candidate.itemKind
    && identity.milestoneId === candidate.milestoneId
    && identity.sliceId === candidate.sliceId
    && identity.taskId === candidate.taskId;
}

function lifecycleWithinHierarchy(
  hierarchy: Readonly<HierarchyIdentity>,
  lifecycle: Readonly<HierarchyIdentity>,
): boolean {
  if (hierarchy.milestoneId !== lifecycle.milestoneId) return false;
  if (hierarchy.itemKind === "milestone") return true;
  if (hierarchy.sliceId !== lifecycle.sliceId) return false;
  return hierarchy.itemKind === "slice" || hierarchy.taskId === lifecycle.taskId;
}

function currentLifecycleIdentities(
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  hierarchy: Readonly<HierarchyIdentity>,
): HierarchyIdentity[] {
  return currentBase.rows.flatMap((row) => {
    if (
      row.row_set !== "item_lifecycles"
      || row.value["project_id"] !== currentBase.authority.project_id
      || (row.value["item_kind"] !== "milestone"
        && row.value["item_kind"] !== "slice"
        && row.value["item_kind"] !== "task")
      || typeof row.value["milestone_id"] !== "string"
    ) return [];
    const identity: HierarchyIdentity = {
      itemKind: row.value["item_kind"],
      milestoneId: row.value["milestone_id"],
      sliceId: typeof row.value["slice_id"] === "string" ? row.value["slice_id"] : null,
      taskId: typeof row.value["task_id"] === "string" ? row.value["task_id"] : null,
    };
    return lifecycleWithinHierarchy(hierarchy, identity) ? [identity] : [];
  });
}

function isUnchangedImportedLifecycle(
  identity: Readonly<HierarchyIdentity>,
  input: Readonly<LegacyImportForwardRepairPlanInput>,
  currentRows: ReadonlyMap<string, LegacyImportBaseRow>,
): boolean {
  const lifecycle = input.currentBase.rows.find((row) => row.row_set === "item_lifecycles"
    && row.value["project_id"] === input.currentBase.authority.project_id
    && row.value["item_kind"] === identity.itemKind
    && row.value["milestone_id"] === identity.milestoneId
    && row.value["slice_id"] === identity.sliceId
    && row.value["task_id"] === identity.taskId);
  const lifecycleInstruction = input.applicationPlan.instructions.find((instruction) => (
    instruction.action === "adopt-lifecycle"
    && sameHierarchyIdentity(identity, {
      itemKind: instruction.itemKind,
      milestoneId: instruction.milestoneId,
      sliceId: instruction.sliceId,
      taskId: instruction.taskId,
    })
  ));
  const rowInstruction = input.applicationPlan.instructions.find(
    (instruction): instruction is LegacyImportApplicationRowInstruction => {
      if (instruction.action !== "create" || instruction.targetKind !== identity.itemKind) return false;
      const candidate = hierarchyIdentity(instruction);
      return candidate !== null && sameHierarchyIdentity(identity, candidate);
    },
  );
  if (!lifecycle || lifecycleInstruction?.action !== "adopt-lifecycle" || !rowInstruction) return false;
  const row = currentRows.get(rowKey(rowInstruction.rowSet, instructionIdentity(rowInstruction)))?.value;
  return lifecycle.value["last_operation_id"] === input.applicationOperationId
    && lifecycle.value["state_version"] === 0
    && lifecycle.value["lifecycle_status"] === lifecycleInstruction.lifecycleStatus
    && row !== undefined
    && includesValues(row, rowInstruction.values);
}

function target(
  instruction: LegacyImportApplicationPlanInstruction,
  instructionIndex: number,
  disposition: LegacyImportForwardRepairDisposition,
  reasonCode: string,
  mutation: LegacyImportForwardRepairMutation | null = null,
  reviewHash: string | null = null,
  review: LegacyImportForwardRepairReview | null = null,
): LegacyImportForwardRepairTarget {
  return {
    instructionIndex,
    targetKind: instruction.targetKind,
    targetKey: instruction.targetKey,
    changeIds: [...instruction.changeIds],
    disposition,
    reasonCode,
    reviewHash,
    review,
    mutation,
  };
}

function choiceForTarget(
  instruction: LegacyImportApplicationPlanInstruction,
  instructionIndex: number,
  choices: ReadonlyMap<number, Readonly<LegacyImportForwardRepairChoice>>,
  unresolvedReason: string,
  restoreMutation: LegacyImportForwardRepairMutation,
  reviewedValue: LegacyImportValue,
): LegacyImportForwardRepairTarget {
  const review: LegacyImportForwardRepairReview = {
    currentValue: reviewedValue,
    proposedMutation: restoreMutation,
    recommendedDecision: "preserve-later",
    recommendationRationale: "Preserve-later preserves accepted canonical work; restore-backup should be chosen only after confirming that work must be reverted.",
  };
  const reviewHash = hashLegacyImportValue({
    instructionIndex,
    targetKind: instruction.targetKind,
    targetKey: instruction.targetKey,
    reasonCode: unresolvedReason,
    review: review as unknown as LegacyImportValue,
  });
  const choice = choices.get(instructionIndex);
  if (!choice) return target(instruction, instructionIndex, "choice-required", unresolvedReason, null, reviewHash, review);
  if (choice.targetKind !== instruction.targetKind || choice.targetKey !== instruction.targetKey
    || choice.reviewHash !== reviewHash) {
    throw new Error("Forward Repair choice does not match its reviewed target");
  }
  if (choice.decision === "preserve-later") {
    return target(instruction, instructionIndex, "preserve", "EXPLICIT_CHOICE_PRESERVE_LATER", null, reviewHash, review);
  }
  if (choice.decision === "restore-backup") {
    return target(
      instruction,
      instructionIndex,
      "safe-revert",
      "EXPLICIT_CHOICE_RESTORE_BACKUP",
      restoreMutation,
      reviewHash,
      review,
    );
  }
  throw new Error("Forward Repair choice decision is invalid");
}

function rowTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "create" | "update" | "delete";
  }>,
  instructionIndex: number,
  backupRows: ReadonlyMap<string, LegacyImportBaseRow>,
  currentRows: ReadonlyMap<string, LegacyImportBaseRow>,
  input: Readonly<LegacyImportForwardRepairPlanInput>,
  choices: ReadonlyMap<number, Readonly<LegacyImportForwardRepairChoice>>,
  goal: LegacyImportForwardRepairGoal,
): LegacyImportForwardRepairTarget {
  const identity = instructionIdentity(instruction);
  const key = rowKey(instruction.rowSet, identity);
  const base = backupRows.get(key)?.value;
  const current = currentRows.get(key)?.value;

  if (instruction.action === "create") {
    if (current === undefined) {
      // Retain mode: the import-created row was deleted by later work. The
      // later deletion is preserved, matching the row-level changed-later
      // rule; the migration projection renders current canonical state.
      return goal === "retain"
        ? target(instruction, instructionIndex, "later-modified", "CREATED_ROW_DELETED_LATER")
        : target(instruction, instructionIndex, "already-repaired", "CREATED_ROW_ABSENT");
    }
    // Compare against the reconstructed post-import row, not instruction.values
    // alone: the import writer inserts only the planned columns, so the stored
    // row also carries the static schema defaults. Comparing the partial
    // instruction values against the full current row always drifts on those
    // defaulted columns and would classify every import-created row as
    // changed-later, making this safe-revert unreachable; comparing only the
    // planned fields would instead miss a later edit to a defaulted column and
    // delete accepted work. The reconstruction detects both directions.
    const importedRow = {
      ...CREATED_ROW_INSERT_DEFAULTS[instruction.rowSet],
      ...instruction.values,
    };
    if (!sameValue(current, importedRow)) {
      if (instruction.targetKind === "artifact") {
        return choiceForTarget(instruction, instructionIndex, choices, "CREATED_ARTIFACT_CHANGED_LATER", {
          action: "delete",
          rowSet: instruction.rowSet,
          identity: instruction.identity,
          values: {},
        }, current as LegacyImportValue);
      }
      return target(instruction, instructionIndex, "later-modified", "CREATED_ROW_CHANGED_LATER");
    }
    const hierarchy = hierarchyIdentity(instruction);
    if (hierarchy) {
      const lifecycles = currentLifecycleIdentities(input.currentBase, hierarchy);
      if (lifecycles.some((lifecycle) => !isUnchangedImportedLifecycle(lifecycle, input, currentRows))) {
        return target(instruction, instructionIndex, "preserve", "LIFECYCLE_REQUIRED_BY_LATER_HIERARCHY");
      }
      if (lifecycles.some((lifecycle) => sameHierarchyIdentity(hierarchy, lifecycle))) {
        return target(instruction, instructionIndex, "preserve", "CREATED_ROW_RETAINED_FOR_LIFECYCLE_TOMBSTONE");
      }
      if (lifecycles.length > 0 && hierarchy.itemKind !== "task") {
        return target(instruction, instructionIndex, "safe-revert", "CREATED_ANCESTOR_TOMBSTONED_FOR_LIFECYCLE", {
          action: "create-cancelled-lifecycle",
          itemKind: hierarchy.itemKind,
          milestoneId: hierarchy.milestoneId,
          sliceId: hierarchy.sliceId,
          taskId: null,
        });
      }
    }
    // Retain mode: the Application's created row is intact, so the Application
    // intent already holds and there is nothing to revert.
    if (goal === "retain") {
      return target(instruction, instructionIndex, "already-repaired", "CREATED_ROW_UNCHANGED");
    }
    return target(instruction, instructionIndex, "safe-revert", "CREATED_ROW_UNCHANGED", {
      action: "delete",
      rowSet: instruction.rowSet,
      identity: instruction.identity,
      values: {},
    });
  }

  if (instruction.action === "delete") {
    if (base === undefined) {
      return target(instruction, instructionIndex, "conflict", "DELETED_ROW_MISSING_FROM_BACKUP");
    }
    if (current === undefined) {
      // Retain mode: the Application's delete intent already holds.
      if (goal === "retain") {
        return target(instruction, instructionIndex, "already-repaired", "DELETED_ROW_STILL_ABSENT");
      }
      return target(instruction, instructionIndex, "safe-revert", "DELETED_ROW_STILL_ABSENT", {
        action: "create",
        rowSet: instruction.rowSet,
        identity: instruction.identity,
        values: base as SqlRecord,
      });
    }
    if (sameValue(current, base)) {
      // Retain mode: later work recreated the row the Application deleted;
      // the recreation is preserved.
      return goal === "retain"
        ? target(instruction, instructionIndex, "later-modified", "DELETED_ROW_RECREATED_LATER")
        : target(instruction, instructionIndex, "already-repaired", "DELETED_ROW_ALREADY_RESTORED");
    }
    if (instruction.targetKind === "artifact") {
      return choiceForTarget(instruction, instructionIndex, choices, "DELETED_ARTIFACT_RECREATED_LATER", {
        action: "create",
        rowSet: instruction.rowSet,
        identity: instruction.identity,
        values: base as SqlRecord,
      }, current as LegacyImportValue);
    }
    return target(instruction, instructionIndex, "later-modified", "DELETED_ROW_RECREATED_LATER");
  }

  if (base === undefined) {
    return target(instruction, instructionIndex, "conflict", "UPDATED_ROW_MISSING_FROM_BACKUP");
  }
  if (current === undefined) {
    if (instruction.targetKind === "artifact") {
      return choiceForTarget(instruction, instructionIndex, choices, "UPDATED_ARTIFACT_DELETED_LATER", {
        action: "create",
        rowSet: instruction.rowSet,
        identity: instruction.identity,
        values: base as SqlRecord,
      }, null);
    }
    return target(instruction, instructionIndex, "later-modified", "UPDATED_ROW_DELETED_LATER");
  }
  const restore: Record<string, SqlValue> = {};
  let revertedToBase = false;
  for (const [field, importedValue] of Object.entries(instruction.values)) {
    const currentValue = current[field];
    const baseValue = base[field];
    if (sameValue(currentValue, baseValue)) {
      if (!sameValue(importedValue, baseValue)) revertedToBase = true;
      continue;
    }
    if (!sameValue(currentValue, importedValue)) {
      const restoreValues = Object.fromEntries(Object.keys(instruction.values)
        .filter((candidate) => !sameValue(current[candidate], base[candidate]))
        .map((candidate) => [candidate, base[candidate] as SqlValue]));
      return choiceForTarget(instruction, instructionIndex, choices, "UPDATED_FIELD_CHANGED_LATER", {
        action: "update",
        rowSet: instruction.rowSet,
        identity: instruction.identity,
        values: restoreValues,
      }, current as LegacyImportValue);
    }
    restore[field] = baseValue as SqlValue;
  }
  if (Object.keys(restore).length === 0) {
    // Retain mode: a meaningful Application update was undone by later work;
    // the later state is preserved.
    if (goal === "retain" && revertedToBase) {
      return target(instruction, instructionIndex, "later-modified", "UPDATED_FIELDS_REVERTED_LATER");
    }
    return target(instruction, instructionIndex, "already-repaired", "UPDATED_FIELDS_ALREADY_RESTORED");
  }
  // Retain mode: every diverged field still holds the imported value, so the
  // Application intent is intact and there is nothing to revert.
  if (goal === "retain") {
    return target(instruction, instructionIndex, "already-repaired", "UPDATED_FIELDS_UNCHANGED");
  }
  return target(instruction, instructionIndex, "safe-revert", "UPDATED_FIELDS_UNCHANGED", {
    action: "update",
    rowSet: instruction.rowSet,
    identity: instruction.identity,
    values: restore,
  });
}

function dependencySet(
  snapshot: Readonly<LegacyImportBaseSnapshot>,
  milestoneId: string,
  sliceId: string,
): string[] {
  return snapshot.rows
    .filter((row) => row.row_set === "slice_dependencies"
      && row.value["milestone_id"] === milestoneId
      && row.value["slice_id"] === sliceId)
    .map((row) => String(row.value["depends_on_slice_id"]))
    .sort();
}

function dependencyTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "replace-slice-dependencies" | "delete-slice-dependencies";
  }>,
  instructionIndex: number,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  choices: ReadonlyMap<number, Readonly<LegacyImportForwardRepairChoice>>,
  goal: LegacyImportForwardRepairGoal,
): LegacyImportForwardRepairTarget {
  const base = dependencySet(backupBase, instruction.milestoneId, instruction.sliceId);
  const current = dependencySet(currentBase, instruction.milestoneId, instruction.sliceId);
  const imported = instruction.action === "replace-slice-dependencies"
    ? [...instruction.dependsOnSliceIds]
    : [];
  if (sameValue(current, base)) {
    // Retain mode: a meaningful Application dependency change was undone by
    // later work; the later state is preserved.
    if (goal === "retain" && !sameValue(imported, base)) {
      return target(instruction, instructionIndex, "later-modified", "DEPENDENCIES_REVERTED_LATER");
    }
    return target(instruction, instructionIndex, "already-repaired", "DEPENDENCIES_ALREADY_RESTORED");
  }
  if (!sameValue(current, imported)) {
    return choiceForTarget(instruction, instructionIndex, choices, "DEPENDENCIES_CHANGED_LATER", {
      action: "replace-slice-dependencies",
      milestoneId: instruction.milestoneId,
      sliceId: instruction.sliceId,
      dependsOnSliceIds: base,
    }, current);
  }
  // Retain mode: the Application's dependency intent is intact.
  if (goal === "retain") {
    return target(instruction, instructionIndex, "already-repaired", "DEPENDENCIES_UNCHANGED");
  }
  return target(instruction, instructionIndex, "safe-revert", "DEPENDENCIES_UNCHANGED", {
    action: "replace-slice-dependencies",
    milestoneId: instruction.milestoneId,
    sliceId: instruction.sliceId,
    dependsOnSliceIds: base,
  });
}

function decisionRow(
  snapshot: Readonly<LegacyImportBaseSnapshot>,
  rowSet: "decisions" | "decision_memories",
  decisionId: string,
): LegacyImportBaseRow | undefined {
  const identity = rowSet === "decisions"
    ? canonicalLegacyImportJson({ id: decisionId })
    : canonicalLegacyImportJson({ source_decision_id: decisionId });
  return snapshot.rows.find((row) => row.row_set === rowSet && row.identity === identity);
}

function decisionFieldsFromBackup(
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  decisionId: string,
): { fields: Record<string, LegacyImportValue>; structuredFields: string | null } | null {
  const memory = decisionRow(backupBase, "decision_memories", decisionId);
  if (memory) {
    const structuredFields = String(memory.value["structured_fields"]);
    const parsed = JSON.parse(structuredFields) as Record<string, LegacyImportValue>;
    return { fields: { ...parsed, id: decisionId }, structuredFields };
  }
  const legacy = decisionRow(backupBase, "decisions", decisionId);
  if (!legacy) return null;
  return { fields: { ...legacy.value }, structuredFields: null };
}

function expectedDecisionFields(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "create-decision-memory" | "update-decision-memory" | "delete-decision-memory";
  }>,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
): string | null {
  const base = decisionFieldsFromBackup(backupBase, instruction.decisionId);
  if (instruction.action !== "create-decision-memory" && base === null) return null;
  const fields: Record<string, LegacyImportValue> = instruction.action === "create-decision-memory"
    ? { ...instruction.values }
    : { ...base!.fields, ...instruction.values, id: instruction.decisionId };
  const structured: Record<string, LegacyImportValue> = {
    sourceDecisionId: instruction.decisionId,
  };
  for (const field of [
    "when_context", "scope", "decision", "choice", "rationale",
    "revisable", "made_by", "source", "superseded_by",
  ]) {
    structured[field] = fields[field] ?? null;
  }
  structured.deleted = instruction.action === "delete-decision-memory";
  return canonicalLegacyImportJson(structured);
}

function currentDecisionFields(
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  decisionId: string,
): string | null {
  const memory = decisionRow(currentBase, "decision_memories", decisionId);
  return memory ? String(memory.value["structured_fields"]) : null;
}

function decisionTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, {
    action: "create-decision-memory" | "update-decision-memory" | "delete-decision-memory";
  }>,
  instructionIndex: number,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  choices: ReadonlyMap<number, Readonly<LegacyImportForwardRepairChoice>>,
  goal: LegacyImportForwardRepairGoal,
): LegacyImportForwardRepairTarget {
  const base = decisionFieldsFromBackup(backupBase, instruction.decisionId);
  const current = currentDecisionFields(currentBase, instruction.decisionId);
  const imported = expectedDecisionFields(instruction, backupBase);
  if (imported === null) {
    return target(instruction, instructionIndex, "conflict", "DECISION_MISSING_FROM_BACKUP");
  }
  if (current === null && base?.structuredFields) {
    // The memory row is gone while the backup retains one: the repair writer
    // restores decision memories by UPDATE only, so offering a restore choice
    // here would deterministically fail at apply time. Preserve the later
    // deletion instead, matching the row-level UPDATED_ROW_DELETED_LATER rule.
    return target(instruction, instructionIndex, "later-modified", "DECISION_MEMORY_DELETED_LATER");
  }
  if (current === (base?.structuredFields ?? null)) {
    // Retain mode: a meaningful Application memory change was undone by later
    // work; the later state is preserved.
    if (goal === "retain" && current !== imported) {
      return target(instruction, instructionIndex, "later-modified", "DECISION_REVERTED_LATER");
    }
    return target(instruction, instructionIndex, "already-repaired", "DECISION_ALREADY_RESTORED");
  }
  if (current !== imported) {
    return choiceForTarget(instruction, instructionIndex, choices, "DECISION_CHANGED_LATER", base?.structuredFields
      ? {
          action: "restore-decision-memory",
          decisionId: instruction.decisionId,
          structuredFields: base.structuredFields,
        }
      : {
          action: "delete-decision-memory",
          decisionId: instruction.decisionId,
          structuredFields: null,
        }, current);
  }
  // Retain mode: the Application's decision memory intent is intact.
  if (goal === "retain") {
    return target(instruction, instructionIndex, "already-repaired", "DECISION_UNCHANGED");
  }
  return target(instruction, instructionIndex, "safe-revert", "DECISION_UNCHANGED", base?.structuredFields
    ? {
        action: "restore-decision-memory",
        decisionId: instruction.decisionId,
        structuredFields: base.structuredFields,
      }
    : {
        action: "delete-decision-memory",
        decisionId: instruction.decisionId,
        structuredFields: null,
      });
}

function lifecycleTarget(
  instruction: Extract<LegacyImportApplicationPlanInstruction, { action: "adopt-lifecycle" }>,
  instructionIndex: number,
  input: Readonly<LegacyImportForwardRepairPlanInput>,
  compiledTargets: readonly LegacyImportForwardRepairTarget[],
): LegacyImportForwardRepairTarget {
  const current = input.currentBase.rows.find((row) => row.row_set === "item_lifecycles"
    && row.value["project_id"] === input.currentBase.authority.project_id
    && row.value["item_kind"] === instruction.itemKind
    && row.value["milestone_id"] === instruction.milestoneId
    && row.value["slice_id"] === (instruction.sliceId ?? null)
    && row.value["task_id"] === (instruction.taskId ?? null));
  if (!current) {
    return target(instruction, instructionIndex, "conflict", "IMPORTED_LIFECYCLE_MISSING");
  }
  const hierarchy = compiledTargets.find((entry) => (
    entry.targetKind === instruction.itemKind && entry.targetKey === instruction.targetKey
  ));
  if (hierarchy?.reasonCode !== "CREATED_ROW_RETAINED_FOR_LIFECYCLE_TOMBSTONE") {
    return target(instruction, instructionIndex, "preserve", "LIFECYCLE_REQUIRED_BY_PRESERVED_HIERARCHY");
  }
  if (
    current.value["last_operation_id"] !== input.applicationOperationId
    || current.value["state_version"] !== 0
    || current.value["lifecycle_status"] !== instruction.lifecycleStatus
  ) {
    return target(instruction, instructionIndex, "preserve", "LIFECYCLE_CHANGED_LATER");
  }
  if (instruction.lifecycleStatus === "cancelled") {
    return target(instruction, instructionIndex, "already-repaired", "IMPORTED_LIFECYCLE_ALREADY_CANCELLED");
  }
  return target(instruction, instructionIndex, "safe-revert", "IMPORTED_LIFECYCLE_UNCHANGED", {
    action: "cancel-imported-lifecycle",
    itemKind: instruction.itemKind,
    milestoneId: instruction.milestoneId,
    sliceId: instruction.sliceId ?? null,
    taskId: instruction.taskId ?? null,
    expectedStatus: instruction.lifecycleStatus,
    expectedStateVersion: 0,
    expectedLastOperationId: input.applicationOperationId,
  });
}

function compileTarget(
  instruction: LegacyImportApplicationPlanInstruction,
  instructionIndex: number,
  backupBase: Readonly<LegacyImportBaseSnapshot>,
  currentBase: Readonly<LegacyImportBaseSnapshot>,
  backupRows: ReadonlyMap<string, LegacyImportBaseRow>,
  currentRows: ReadonlyMap<string, LegacyImportBaseRow>,
  choices: ReadonlyMap<number, Readonly<LegacyImportForwardRepairChoice>>,
  input: Readonly<LegacyImportForwardRepairPlanInput>,
  compiledTargets: readonly LegacyImportForwardRepairTarget[],
  goal: LegacyImportForwardRepairGoal,
): LegacyImportForwardRepairTarget {
  if (instruction.action === "create" || instruction.action === "update" || instruction.action === "delete") {
    return rowTarget(instruction, instructionIndex, backupRows, currentRows, input, choices, goal);
  }
  if (instruction.action === "replace-slice-dependencies" || instruction.action === "delete-slice-dependencies") {
    return dependencyTarget(instruction, instructionIndex, backupBase, currentBase, choices, goal);
  }
  if (
    instruction.action === "create-decision-memory"
    || instruction.action === "update-decision-memory"
    || instruction.action === "delete-decision-memory"
  ) {
    return decisionTarget(instruction, instructionIndex, backupBase, currentBase, choices, goal);
  }
  if (instruction.action === "adopt-lifecycle") {
    return lifecycleTarget(instruction, instructionIndex, input, compiledTargets);
  }
  if (instruction.action === "seed-quality-gate") {
    // The seeded Q8 row is companion authority for a created slice. Revert
    // retains created hierarchy rows as cancelled lifecycle tombstones (see
    // lifecycleTarget), so the gate row stays beside its slice; a Q8 row on a
    // cancelled slice is inert because complete-slice never runs for it.
    return target(instruction, instructionIndex, "preserve", "QUALITY_GATE_RETAINED_WITH_HIERARCHY");
  }
  return target(instruction, instructionIndex, "preserve", "APPLICATION_PRESERVED_TARGET");
}

export function compileLegacyImportForwardRepairPlan(
  input: Readonly<LegacyImportForwardRepairPlanInput>,
): LegacyImportForwardRepairPlan {
  const goal = input.goal ?? "revert";
  if (goal !== "revert" && goal !== "retain") {
    throw new Error("Forward Repair goal is invalid");
  }
  if (
    input.backupBase.authority.project_id !== input.currentBase.authority.project_id
    || input.backupBase.authority.revision !== input.applicationPlan.baseProjectRevision
    || input.backupBase.authority.authority_epoch !== input.applicationPlan.baseAuthorityEpoch
    || input.applicationPlan.previewId !== input.previewId
    || input.applicationPlan.previewHash !== input.previewHash
  ) {
    throw new Error("Forward Repair base and Application evidence are inconsistent");
  }
  const backupRows = rowIndex(input.backupBase);
  const currentRows = rowIndex(input.currentBase);
  const choices = new Map<number, Readonly<LegacyImportForwardRepairChoice>>();
  for (const choice of input.choices ?? []) {
    if (choices.has(choice.instructionIndex)) throw new Error("Forward Repair choice target is duplicated");
    choices.set(choice.instructionIndex, choice);
  }
  const targets: LegacyImportForwardRepairTarget[] = [];
  input.applicationPlan.instructions.forEach((instruction, index) => {
    targets.push(compileTarget(
      instruction,
      index,
      input.backupBase,
      input.currentBase,
      backupRows,
      currentRows,
      choices,
      input,
      targets,
      goal,
    ));
  });
  if ([...choices.keys()].some((index) => targets[index]?.reasonCode !== "EXPLICIT_CHOICE_PRESERVE_LATER"
    && targets[index]?.reasonCode !== "EXPLICIT_CHOICE_RESTORE_BACKUP")) {
    throw new Error("Forward Repair choice does not resolve a genuine overlap");
  }
  const mutationCount = targets.filter((entry) => entry.mutation !== null).length;
  const preservedCount = targets.filter((entry) => (
    entry.disposition === "already-repaired"
    || entry.disposition === "later-modified"
    || entry.disposition === "preserve"
  )).length;
  const rejectedCount = targets.filter((entry) => entry.disposition === "conflict").length;
  const unresolvedCount = targets.filter((entry) => entry.disposition === "choice-required").length;
  const differenceHash = hashLegacyImportValue({
    applicationOperationId: input.applicationOperationId,
    baseRelevantRowsHash: input.backupBase.relevant_rows_hash,
    applicationRelevantRowsHash: input.applicationRelevantRowsHash,
    currentRelevantRowsHash: input.currentBase.relevant_rows_hash,
    currentProjectRevision: input.currentBase.authority.revision,
    currentAuthorityEpoch: input.currentBase.authority.authority_epoch,
  });
  return deepFreeze({
    planSchemaVersion: LEGACY_IMPORT_FORWARD_REPAIR_PLAN_SCHEMA_VERSION,
    goal,
    applicationOperationId: input.applicationOperationId,
    applicationIdentityHash: input.applicationIdentityHash,
    previewId: input.previewId,
    previewHash: input.previewHash,
    backupId: input.backupId,
    differenceHash,
    expectedProjectRevision: input.currentBase.authority.revision,
    expectedAuthorityEpoch: input.currentBase.authority.authority_epoch,
    baseRelevantRowsHash: input.backupBase.relevant_rows_hash,
    applicationRelevantRowsHash: input.applicationRelevantRowsHash,
    currentRelevantRowsHash: input.currentBase.relevant_rows_hash,
    targetCount: targets.length,
    mutationCount,
    preservedCount,
    rejectedCount,
    unresolvedCount,
    targets,
  });
}
