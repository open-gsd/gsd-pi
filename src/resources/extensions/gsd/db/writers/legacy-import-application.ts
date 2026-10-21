// Project/App: gsd-pi
// File Purpose: Strict context-bound executor for compiled legacy import Application plans.

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import {
  adoptLifecycleIfMissing,
  requireActiveDomainOperationContext,
} from "./lifecycle-commands.js";
import {
  LegacyImportApplicationError,
} from "../../legacy-import-application-error.js";
import {
  isValidLegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackup,
} from "../../legacy-import-backup.js";
import {
  LEGACY_IMPORT_APPLICATION_PLAN_SCHEMA_VERSION,
  type LegacyImportApplicationDecisionInstruction,
  type LegacyImportApplicationPlan,
  type LegacyImportApplicationPlanInstruction,
  type LegacyImportApplicationRowInstruction,
} from "../../legacy-import-application-plan.js";
import { compareText } from "../../legacy-import-utils.js";
import { LEGACY_IMPORT_TARGET_ADAPTERS } from "../../legacy-import-preview-classifier-targets.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  isStrictLegacyImportData,
  isValidLegacyImportPreviewArtifact,
  type LegacyImportPreviewArtifact,
} from "../../legacy-import-preview.js";
import { synthesizeDecisionMemoryContent } from "../../memory-backfill.js";

type SqlValue = null | number | string;
type SqlRecord = Readonly<Record<string, SqlValue>>;
type DbRow = Record<string, unknown>;

export interface LegacyImportApplicationInstructionResult {
  readonly action: LegacyImportApplicationPlanInstruction["action"];
  readonly targetKind: string;
  readonly targetIdentityHash: string;
  readonly expectedAffectedRows: number;
  readonly affectedRows: number;
}

export interface LegacyImportApplicationWriterResult {
  readonly instructionResults: readonly LegacyImportApplicationInstructionResult[];
}

interface RowDefinition {
  table: string;
  identity: readonly string[];
  fields: ReadonlySet<string>;
}

const ROW_DEFINITIONS: Readonly<Record<LegacyImportApplicationRowInstruction["targetKind"], RowDefinition>> = {
  milestone: definition("milestones", ["id"], LEGACY_IMPORT_TARGET_ADAPTERS.milestone.fields),
  slice: definition("slices", ["milestone_id", "id"], LEGACY_IMPORT_TARGET_ADAPTERS.slice.fields),
  task: definition("tasks", ["milestone_id", "slice_id", "id"], LEGACY_IMPORT_TARGET_ADAPTERS.task.fields),
  requirement: definition("requirements", ["id"], LEGACY_IMPORT_TARGET_ADAPTERS.requirement.fields),
  artifact: definition("artifacts", ["path"], LEGACY_IMPORT_TARGET_ADAPTERS.artifact.fields),
  assessment: definition(
    "assessments",
    ["path", "milestone_id", "slice_id", "task_id", "scope"],
    LEGACY_IMPORT_TARGET_ADAPTERS.assessment.fields,
  ),
};

const DECISION_FIELDS = new Set([
  "id", "when_context", "scope", "decision", "choice", "rationale", "revisable",
  "made_by", "source", "superseded_by",
]);

function definition(table: string, identity: readonly string[], fields: ReadonlySet<string>): RowDefinition {
  return { table, identity, fields };
}

function fail(message: string): never {
  throw new LegacyImportApplicationError(
    "transaction",
    "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED",
    message,
    false,
  );
}

function changes(result: unknown): number {
  const value = (result as { changes?: unknown })?.changes;
  return typeof value === "number" ? value : 0;
}

function resultFor(
  instruction: LegacyImportApplicationPlanInstruction,
  expectedAffectedRows: number,
  affectedRows = expectedAffectedRows,
): LegacyImportApplicationInstructionResult {
  return Object.freeze({
    action: instruction.action,
    targetKind: instruction.targetKind,
    targetIdentityHash: hashLegacyImportValue({
      kind: instruction.targetKind,
      key: instruction.targetKey,
    }),
    expectedAffectedRows,
    affectedRows,
  });
}

function ownPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function preflightSqlRecord(value: unknown, allowed: ReadonlySet<string>, label: string): void {
  if (!ownPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must be a plain SQL record`);
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!allowed.has(field)) fail(`${label} contains unsupported field ${field}`);
    if (fieldValue !== null && typeof fieldValue !== "string" && typeof fieldValue !== "number") {
      fail(`${label} field ${field} is not a bound SQL value`);
    }
  }
}

function preflightRow(instruction: LegacyImportApplicationRowInstruction): void {
  const definition = ROW_DEFINITIONS[instruction.targetKind];
  if (!definition || instruction.rowSet !== definition.table) {
    fail("legacy import row target mapping is unsupported");
  }
  preflightSqlRecord(instruction.identity, definition.fields, "legacy import identity");
  preflightSqlRecord(instruction.values, definition.fields, "legacy import values");
  const identityKeys = Object.keys(instruction.identity).sort();
  if (identityKeys.join("\0") !== [...definition.identity].sort().join("\0")) {
    fail("legacy import row identity does not match its allowlisted shape");
  }
  if (instruction.action === "create") {
    for (const field of definition.identity) {
      if (instruction.values[field] !== instruction.identity[field]) {
        fail("legacy import create values disagree with row identity");
      }
    }
  } else if (instruction.action === "delete" && Object.keys(instruction.values).length !== 0) {
    fail("legacy import delete cannot carry writable values");
  } else if (instruction.action === "update") {
    if (Object.keys(instruction.values).length === 0) fail("legacy import update has no fields");
    if (Object.keys(instruction.values).some((field) => definition.identity.includes(field))) {
      fail("legacy import update cannot patch identity fields");
    }
  }
}

function preflightDecision(instruction: LegacyImportApplicationDecisionInstruction): void {
  if (
    instruction.targetKind !== "decision"
    || instruction.decisionId !== instruction.targetKey
    || instruction.decisionId.trim().length === 0
  ) {
    fail("legacy import decision identity is inconsistent");
  }
  preflightSqlRecord(instruction.values, DECISION_FIELDS, "legacy import decision values");
  for (const [field, value] of Object.entries(instruction.values)) {
    if (field === "superseded_by") {
      if (value !== null && typeof value !== "string") fail("legacy import decision supersession is invalid");
    } else if (field === "made_by") {
      if (value !== "human" && value !== "agent" && value !== "collaborative") {
        fail("legacy import decision author is invalid");
      }
    } else if (typeof value !== "string") {
      fail(`legacy import decision field ${field} must be text`);
    }
  }
  if (instruction.action === "create-decision-memory") {
    if (instruction.values["id"] !== instruction.decisionId) {
      fail("legacy import decision create identity is inconsistent");
    }
    if (Object.keys(instruction.values).sort().join("\0") !== [...DECISION_FIELDS].sort().join("\0")) {
      fail("legacy import decision create must contain the complete canonical record");
    }
  } else if (Object.hasOwn(instruction.values, "id")) {
    fail("legacy import decision patch cannot change identity");
  }
  if (instruction.action === "delete-decision-memory" && Object.keys(instruction.values).length !== 0) {
    fail("legacy import decision tombstone cannot carry a patch");
  }
}

function preflight(plan: LegacyImportApplicationPlan): LegacyImportApplicationPlan {
  if (!isStrictLegacyImportData(plan)) fail("legacy import Application plan must be strict data");
  let snapshot: LegacyImportApplicationPlan;
  try {
    snapshot = structuredClone(plan);
  } catch {
    fail("legacy import Application plan could not be detached");
  }
  if (snapshot.planSchemaVersion !== LEGACY_IMPORT_APPLICATION_PLAN_SCHEMA_VERSION) {
    fail("legacy import Application plan schema version is unsupported");
  }
  for (const instruction of snapshot.instructions) {
    if (instruction.action === "create" || instruction.action === "update" || instruction.action === "delete") {
      preflightRow(instruction);
    } else if (
      instruction.action === "create-decision-memory"
      || instruction.action === "update-decision-memory"
      || instruction.action === "delete-decision-memory"
    ) {
      preflightDecision(instruction);
    } else if (instruction.action === "adopt-lifecycle") {
      if (instruction.lifecycleAction !== "create" && instruction.lifecycleAction !== "update") {
        fail("legacy import lifecycle action is unsupported");
      }
      const hasSlice = typeof instruction.sliceId === "string" && instruction.sliceId.trim().length > 0;
      const hasTask = typeof instruction.taskId === "string" && instruction.taskId.trim().length > 0;
      if (
        (instruction.itemKind === "milestone" && (instruction.sliceId != null || instruction.taskId != null))
        || (instruction.itemKind === "slice" && (!hasSlice || instruction.taskId != null))
        || (instruction.itemKind === "task" && (!hasSlice || !hasTask))
      ) fail("legacy import lifecycle identity shape is invalid");
      const targetKey = instruction.itemKind === "milestone"
        ? instruction.milestoneId
        : instruction.itemKind === "slice"
          ? `${instruction.milestoneId}/${instruction.sliceId}`
          : `${instruction.milestoneId}/${instruction.sliceId}/${instruction.taskId}`;
      if (instruction.targetKind !== `${instruction.itemKind}-lifecycle` || instruction.targetKey !== targetKey) {
        fail("legacy import lifecycle target identity is inconsistent");
      }
    } else if (instruction.action === "seed-quality-gate") {
      if (
        instruction.targetKind !== "slice-quality-gate"
        || instruction.milestoneId.trim().length === 0
        || instruction.sliceId.trim().length === 0
        || (instruction.gateStatus !== "pending" && instruction.gateStatus !== "complete")
        || instruction.targetKey !== `${instruction.milestoneId}/${instruction.sliceId}`
      ) fail("legacy import quality gate instruction is invalid");
    } else if (instruction.action === "replace-slice-dependencies") {
      if (instruction.dependsOnSliceIds.includes(instruction.sliceId)) {
        fail("legacy import slice cannot depend on itself");
      }
    } else if (instruction.action !== "delete-slice-dependencies" && instruction.action !== "preserve") {
      fail("legacy import instruction action is unsupported");
    }
  }
  return snapshot;
}

function requireApplicationContext(
  context: Readonly<DomainOperationContext>,
  plan: LegacyImportApplicationPlan,
): string {
  if (requireActiveDomainOperationContext(context) !== "import.apply") {
    fail("legacy import Application writer requires an active import.apply context");
  }
  const row = getDb().prepare(`SELECT
      operation.operation_type, operation.expected_revision, operation.resulting_revision,
      operation.expected_authority_epoch, operation.resulting_authority_epoch,
      operation.request_hash, operation.created_at
    FROM workflow_operations operation
    WHERE operation.operation_id = :operation_id
      AND operation.project_id = :project_id`).get({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
  }) as DbRow | undefined;
  if (
    !row
    || row["operation_type"] !== "import.apply"
    || row["expected_revision"] !== plan.baseProjectRevision
    || row["resulting_revision"] !== context.resultingRevision
    || row["expected_authority_epoch"] !== plan.baseAuthorityEpoch
    || row["resulting_authority_epoch"] !== context.resultingAuthorityEpoch
    || row["request_hash"] !== plan.previewHash
    || typeof row["created_at"] !== "string"
    || row["created_at"].trim().length === 0
  ) fail("legacy import Application preview or authority fence does not match the active context");
  return row["created_at"];
}

function detachReceiptEvidence(
  preview: LegacyImportPreviewArtifact,
  backup: LegacyImportVerifiedBackup,
): { preview: LegacyImportPreviewArtifact; backup: LegacyImportVerifiedBackup } {
  const evidence = { preview, backup };
  if (!isStrictLegacyImportData(evidence)) {
    fail("legacy import Application receipt evidence must be strict data");
  }
  let snapshot: typeof evidence;
  try {
    snapshot = structuredClone(evidence);
  } catch {
    fail("legacy import Application receipt evidence could not be detached");
  }
  if (
    !isValidLegacyImportPreviewArtifact(snapshot.preview)
    || !isValidLegacyImportVerifiedBackup(snapshot.backup)
  ) {
    fail("legacy import Application receipt evidence is invalid");
  }
  return snapshot;
}

function requireReceiptEvidenceMatches(
  context: Readonly<DomainOperationContext>,
  plan: LegacyImportApplicationPlan,
  preview: LegacyImportPreviewArtifact,
  backup: LegacyImportVerifiedBackup,
): void {
  const envelope = preview.preview;
  const expectedSourceFingerprints = envelope.sources.map((source) => ({
    source_id: source.source_id,
    path: source.path,
    kind: source.kind,
    byte_size: source.byte_size,
    sha256: source.sha256,
  }));
  if (
    envelope.preview_id !== plan.previewId
    || preview.preview_hash !== plan.previewHash
    || envelope.base_project_revision !== plan.baseProjectRevision
    || envelope.base_authority_epoch !== plan.baseAuthorityEpoch
    || envelope.counts.unresolved !== 0
    || backup.preview_id !== envelope.preview_id
    || backup.preview_hash !== preview.preview_hash
    || backup.preview_schema_version !== envelope.preview_schema_version
    || backup.import_kind !== envelope.import_kind
    || backup.importer_version !== envelope.importer_version
    || backup.source_set_hash !== envelope.source_set_hash
    || backup.source_count !== envelope.sources.length
    || canonicalLegacyImportJson(backup.source_fingerprints)
      !== canonicalLegacyImportJson(expectedSourceFingerprints)
    || backup.project_id !== context.projectId
    || backup.backup_database_schema_version !== envelope.base_database_schema_version
    || backup.base_project_revision !== envelope.base_project_revision
    || backup.base_authority_epoch !== envelope.base_authority_epoch
  ) {
    fail("legacy import Application receipt evidence does not match the active plan");
  }
}

function sortedEntries(record: SqlRecord): Array<[string, SqlValue]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function whereClause(identity: SqlRecord, params: Record<string, unknown>): string {
  return sortedEntries(identity).map(([field, value], index) => {
    const name = `:identity_${index}`;
    params[name] = value;
    return value === null ? `${field} IS NULL` : `${field} = ${name}`;
  }).join(" AND ");
}

function rowExists(table: string, identity: SqlRecord): boolean {
  const params: Record<string, unknown> = {};
  return getDb().prepare(`SELECT 1 AS present FROM ${table} WHERE ${whereClause(identity, params)} LIMIT 1`)
    .get(params) !== undefined;
}

function requireHierarchyParents(instruction: LegacyImportApplicationRowInstruction): void {
  const values = instruction.action === "create" ? instruction.values : instruction.identity;
  const milestoneId = values["milestone_id"];
  const sliceId = values["slice_id"];
  const taskId = values["task_id"];
  if (typeof milestoneId === "string" && !rowExists("milestones", { id: milestoneId })) {
    fail("legacy import hierarchy parent milestone is missing");
  }
  if (typeof sliceId === "string") {
    if (typeof milestoneId !== "string" || !rowExists("slices", { milestone_id: milestoneId, id: sliceId })) {
      fail("legacy import hierarchy parent slice is missing");
    }
  }
  if (typeof taskId === "string") {
    if (
      typeof milestoneId !== "string" || typeof sliceId !== "string"
      || !rowExists("tasks", { milestone_id: milestoneId, slice_id: sliceId, id: taskId })
    ) fail("legacy import hierarchy parent task is missing");
  }
}

function requireStoredReferenceParents(instruction: LegacyImportApplicationRowInstruction): void {
  if (instruction.targetKind !== "artifact" && instruction.targetKind !== "assessment") return;
  const definition = ROW_DEFINITIONS[instruction.targetKind];
  const params: Record<string, unknown> = {};
  const stored = getDb().prepare(`SELECT milestone_id, slice_id, task_id FROM ${definition.table}
    WHERE ${whereClause(instruction.identity, params)}`).get(params) as DbRow | undefined;
  const value = (field: string): SqlValue => (
    Object.hasOwn(instruction.values, field)
      ? instruction.values[field] ?? null
      : stored?.[field] === null || typeof stored?.[field] === "string" || typeof stored?.[field] === "number"
        ? stored[field] as SqlValue
        : null
  );
  const values = {
    milestone_id: value("milestone_id"),
    slice_id: value("slice_id"),
    task_id: value("task_id"),
  };
  requireHierarchyParents({ ...instruction, action: "create", values } as LegacyImportApplicationRowInstruction);
}

function hasScopedRow(
  table: string,
  milestoneId: string,
  sliceId?: string,
  taskId?: string,
): boolean {
  const params: Record<string, unknown> = { ":milestone_id": milestoneId };
  const predicates = ["milestone_id = :milestone_id"];
  if (sliceId !== undefined) {
    predicates.push("slice_id = :slice_id");
    params[":slice_id"] = sliceId;
  }
  if (taskId !== undefined) {
    predicates.push("task_id = :task_id");
    params[":task_id"] = taskId;
  }
  return getDb().prepare(`SELECT 1 FROM ${table} WHERE ${predicates.join(" AND ")} LIMIT 1`).get(params) !== undefined;
}

function requireSafeHierarchyDelete(instruction: LegacyImportApplicationRowInstruction): void {
  if (instruction.targetKind !== "task" && instruction.targetKind !== "slice" && instruction.targetKind !== "milestone") return;
  const milestoneId = String(instruction.identity["milestone_id"] ?? instruction.identity["id"]);
  const sliceId = instruction.targetKind === "milestone" ? undefined : String(instruction.identity["slice_id"] ?? instruction.identity["id"]);
  const taskId = instruction.targetKind === "task" ? String(instruction.identity["id"]) : undefined;
  const params: Record<string, unknown> = { ":milestone_id": milestoneId };
  const predicates = ["milestone_id = :milestone_id"];
  if (sliceId !== undefined) {
    predicates.push("slice_id = :slice_id");
    params[":slice_id"] = sliceId;
  }
  if (taskId !== undefined) {
    predicates.push("task_id = :task_id");
    params[":task_id"] = taskId;
  }
  if (getDb().prepare(`SELECT 1 FROM workflow_item_lifecycles WHERE ${predicates.join(" AND ")} LIMIT 1`).get(params)) {
    fail("legacy import cannot delete hierarchy with adopted lifecycle history");
  }
  for (const table of [
    "unit_dispatches", "verification_evidence", "quality_gates", "gate_runs", "replan_history",
    "rework_briefs", "milestone_commit_attributions", "artifacts", "assessments",
  ]) {
    if (hasScopedRow(table, milestoneId, sliceId, taskId)) {
      fail(`legacy import cannot delete hierarchy with retained ${table} history`);
    }
  }
  if (instruction.targetKind === "milestone" && hasScopedRow("milestone_leases", milestoneId)) {
    fail("legacy import cannot delete a leased milestone");
  }
  const entityId = [milestoneId, sliceId, taskId].filter((value) => value !== undefined).join("/");
  if (getDb().prepare(`SELECT 1 FROM workflow_domain_events
    WHERE project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      AND entity_type IN ('milestone', 'slice', 'task')
      AND (entity_id = :entity_id OR substr(entity_id, 1, length(:descendant)) = :descendant)
    LIMIT 1`).get({
    ":entity_id": entityId,
    ":descendant": `${entityId}/`,
  })) fail("legacy import cannot delete hierarchy with immutable domain history");
  if (instruction.targetKind === "milestone") {
    if (rowExists("slices", { milestone_id: milestoneId })) fail("legacy import milestone still has child slices");
  } else if (instruction.targetKind === "slice") {
    if (rowExists("tasks", { milestone_id: milestoneId, slice_id: sliceId! })) {
      fail("legacy import slice still has child tasks");
    }
    const dependency = getDb().prepare(`SELECT 1 FROM slice_dependencies
      WHERE milestone_id = :milestone_id AND (slice_id = :slice_id OR depends_on_slice_id = :slice_id) LIMIT 1`)
      .get({ ":milestone_id": milestoneId, ":slice_id": sliceId });
    if (dependency) fail("legacy import slice still has dependency references");
  }
}

function applyRow(instruction: LegacyImportApplicationRowInstruction): LegacyImportApplicationInstructionResult {
  const definition = ROW_DEFINITIONS[instruction.targetKind];
  if (instruction.action === "create") requireHierarchyParents(instruction);
  if (instruction.action === "update") requireStoredReferenceParents(instruction);
  if (instruction.action === "delete") requireSafeHierarchyDelete(instruction);
  const params: Record<string, unknown> = {};
  let sql: string;
  if (instruction.action === "create") {
    const entries = sortedEntries(instruction.values);
    for (const [field, value] of entries) params[`:${field}`] = value;
    sql = `INSERT INTO ${definition.table} (${entries.map(([field]) => field).join(", ")}) VALUES (${entries.map(([field]) => `:${field}`).join(", ")})`;
  } else if (instruction.action === "update") {
    const entries = sortedEntries(instruction.values);
    for (const [field, value] of entries) params[`:${field}`] = value;
    sql = `UPDATE ${definition.table} SET ${entries.map(([field]) => `${field} = :${field}`).join(", ")} WHERE ${whereClause(instruction.identity, params)}`;
  } else {
    sql = `DELETE FROM ${definition.table} WHERE ${whereClause(instruction.identity, params)}`;
  }
  const affected = changes(getDb().prepare(sql).run(params));
  if (affected !== 1) fail(`legacy import ${instruction.action} must affect exactly one row`);
  return resultFor(instruction, 1, affected);
}

function requireSlice(milestoneId: string, sliceId: string): void {
  if (!rowExists("slices", { milestone_id: milestoneId, id: sliceId })) {
    fail("legacy import slice dependency parent is missing");
  }
}

function replaceDependencies(
  instruction: Extract<LegacyImportApplicationPlanInstruction, { action: "replace-slice-dependencies" }>,
): LegacyImportApplicationInstructionResult {
  requireSlice(instruction.milestoneId, instruction.sliceId);
  for (const dependency of instruction.dependsOnSliceIds) requireSlice(instruction.milestoneId, dependency);
  const params = { ":milestone_id": instruction.milestoneId, ":slice_id": instruction.sliceId };
  const deleted = changes(getDb().prepare(`DELETE FROM slice_dependencies
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id`).run(params));
  let inserted = 0;
  for (const dependency of instruction.dependsOnSliceIds) {
    inserted += changes(getDb().prepare(`INSERT INTO slice_dependencies
      (milestone_id, slice_id, depends_on_slice_id)
      VALUES (:milestone_id, :slice_id, :dependency)`).run({ ...params, ":dependency": dependency }));
  }
  const observed = (getDb().prepare(`SELECT depends_on_slice_id FROM slice_dependencies
    WHERE milestone_id = :milestone_id AND slice_id = :slice_id`).all(params) as DbRow[])
    .map((row) => String(row["depends_on_slice_id"]))
    .sort(compareText);
  if (
    inserted !== instruction.dependsOnSliceIds.length
    || observed.join("\0") !== [...instruction.dependsOnSliceIds].sort(compareText).join("\0")
  ) fail("legacy import slice dependency replacement did not produce the exact set");
  return resultFor(instruction, instruction.dependsOnSliceIds.length, deleted + inserted);
}

function deleteDependencies(
  instruction: Extract<LegacyImportApplicationPlanInstruction, { action: "delete-slice-dependencies" }>,
): LegacyImportApplicationInstructionResult {
  const affected = changes(getDb().prepare(`DELETE FROM slice_dependencies
    WHERE milestone_id = :milestone_id
      AND (slice_id = :slice_id OR depends_on_slice_id = :slice_id)`).run({
    ":milestone_id": instruction.milestoneId,
    ":slice_id": instruction.sliceId,
  }));
  return resultFor(instruction, 0, affected);
}

function requireRetainedSliceDependencyIntegrity(
  instructions: readonly LegacyImportApplicationPlanInstruction[],
): void {
  const milestoneIds = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.action === "delete-slice-dependencies") milestoneIds.add(instruction.milestoneId);
  }
  if (milestoneIds.size === 0) return;
  const retained = getDb().prepare("SELECT milestone_id, id, depends FROM slices").all() as DbRow[];
  for (const row of retained) {
    const milestoneId = String(row["milestone_id"]);
    if (!milestoneIds.has(milestoneId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row["depends"] ?? "[]"));
    } catch {
      fail("legacy import retained slice dependencies are invalid JSON");
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      fail("legacy import retained slice dependencies are not string IDs");
    }
    for (const dependency of parsed) {
      if (!rowExists("slices", { milestone_id: milestoneId, id: dependency })) {
        fail("legacy import retained slice depends on a deleted slice");
      }
    }
  }
}

type DecisionAuthority =
  | { kind: "missing" }
  | { kind: "legacy"; fields: Record<string, SqlValue> }
  | { kind: "memory"; memoryId: string; fields: Record<string, SqlValue>; deleted: boolean };

function parseDecisionFields(
  raw: string,
  expectedId: string,
): { fields: Record<string, SqlValue>; deleted: boolean } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("legacy import decision memory JSON is invalid"); }
  if (!ownPlainRecord(value) || value["sourceDecisionId"] !== expectedId) {
    fail("legacy import decision memory identity is invalid");
  }
  const fields: Record<string, SqlValue> = { id: expectedId };
  for (const field of DECISION_FIELDS) {
    if (field === "id") continue;
    const entry = value[field];
    if (field === "source" && entry === undefined) {
      fields.source = "discussion";
    } else if (field === "superseded_by" && (entry === null || typeof entry === "string")) {
      fields[field] = entry;
    } else if (field === "made_by" && (entry === "human" || entry === "agent" || entry === "collaborative")) {
      fields[field] = entry;
    } else if (typeof entry === "string") {
      fields[field] = entry;
    } else {
      fail(`legacy import decision memory field ${field} is invalid`);
    }
  }
  if (value["deleted"] !== undefined && typeof value["deleted"] !== "boolean") {
    fail("legacy import decision memory tombstone marker is invalid");
  }
  return { fields, deleted: value["deleted"] === true };
}

function decisionAuthority(id: string): DecisionAuthority {
  const markerRows = getDb().prepare(`SELECT id, structured_fields FROM memories
    WHERE category = 'architecture'
      AND instr(structured_fields, '"sourceDecisionId"') > 0
    ORDER BY seq`).all() as DbRow[];
  const memoryRows = markerRows.filter((row) => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row["structured_fields"])); } catch {
      fail("legacy import decision memory JSON is invalid");
    }
    if (!ownPlainRecord(parsed) || typeof parsed["sourceDecisionId"] !== "string") {
      fail("legacy import decision memory identity is invalid");
    }
    return parsed["sourceDecisionId"] === id;
  });
  if (memoryRows.length > 1) fail("legacy import decision has duplicate canonical memory authority");
  if (memoryRows.length === 1) {
    const decoded = parseDecisionFields(String(memoryRows[0]!["structured_fields"]), id);
    return {
      kind: "memory",
      memoryId: String(memoryRows[0]!["id"]),
      ...decoded,
    };
  }
  const legacy = getDb().prepare(`SELECT id, when_context, scope, decision, choice, rationale,
    revisable, made_by, source, superseded_by FROM decisions WHERE id = :id`).get({ ":id": id }) as DbRow | undefined;
  if (!legacy) return { kind: "missing" };
  return {
    kind: "legacy",
    fields: {
      id,
      when_context: String(legacy["when_context"] ?? ""),
      scope: String(legacy["scope"] ?? ""),
      decision: String(legacy["decision"] ?? ""),
      choice: String(legacy["choice"] ?? ""),
      rationale: String(legacy["rationale"] ?? ""),
      revisable: String(legacy["revisable"] ?? ""),
      made_by: String(legacy["made_by"] ?? "agent"),
      source: String(legacy["source"] ?? "discussion"),
      superseded_by: legacy["superseded_by"] === null ? null : String(legacy["superseded_by"] ?? ""),
    },
  };
}

function validatePostPlanDecisionGraph(plan: LegacyImportApplicationPlan): void {
  const supersededBy = new Map<string, string | null>();
  const legacyRows = getDb().prepare("SELECT id, superseded_by FROM decisions ORDER BY id").all() as DbRow[];
  for (const row of legacyRows) {
    const id = String(row["id"]);
    supersededBy.set(id, row["superseded_by"] === null ? null : String(row["superseded_by"] ?? ""));
  }
  const memoryRows = getDb().prepare(`SELECT structured_fields FROM memories
    WHERE category = 'architecture'
      AND instr(structured_fields, '"sourceDecisionId"') > 0
    ORDER BY seq`).all() as DbRow[];
  const memoryIds = new Set<string>();
  for (const row of memoryRows) {
    const raw = String(row["structured_fields"]);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail("legacy import decision memory JSON is invalid"); }
    if (!ownPlainRecord(parsed) || typeof parsed["sourceDecisionId"] !== "string") {
      fail("legacy import decision memory identity is invalid");
    }
    const id = parsed["sourceDecisionId"];
    if (memoryIds.has(id)) fail("legacy import decision has duplicate canonical memory authority");
    memoryIds.add(id);
    if (parsed["deleted"] === true) supersededBy.delete(id);
    else supersededBy.set(id, typeof parsed["superseded_by"] === "string" ? parsed["superseded_by"] : null);
  }
  for (const instruction of plan.instructions) {
    if (instruction.action === "create-decision-memory") {
      supersededBy.set(
        instruction.decisionId,
        typeof instruction.values["superseded_by"] === "string" ? instruction.values["superseded_by"] : null,
      );
    } else if (instruction.action === "update-decision-memory") {
      if (!supersededBy.has(instruction.decisionId)) fail("legacy import decision update target is missing");
      if (Object.hasOwn(instruction.values, "superseded_by")) {
        supersededBy.set(
          instruction.decisionId,
          typeof instruction.values["superseded_by"] === "string" ? instruction.values["superseded_by"] : null,
        );
      }
    } else if (instruction.action === "delete-decision-memory") {
      if (!supersededBy.delete(instruction.decisionId)) fail("legacy import decision delete target is missing");
    }
  }
  for (const [id, target] of supersededBy) {
    if (target !== null && (!supersededBy.has(target) || target === id)) {
      fail("legacy import decision supersession target is missing or self-referential");
    }
    const seen = new Set([id]);
    let cursor = target;
    while (cursor !== null) {
      if (seen.has(cursor)) fail("legacy import decision supersession cycle is invalid");
      seen.add(cursor);
      cursor = supersededBy.get(cursor) ?? null;
    }
  }
}

function decisionStructured(fields: Record<string, SqlValue>, deleted: boolean): Record<string, unknown> {
  const structured: Record<string, unknown> = { sourceDecisionId: String(fields.id) };
  for (const field of DECISION_FIELDS) {
    if (field === "id") continue;
    structured[field] = fields[field];
  }
  structured.deleted = deleted;
  return structured;
}

function writeDecisionMemory(
  context: Readonly<DomainOperationContext>,
  occurredAt: string,
  authority: DecisionAuthority,
  fields: Record<string, SqlValue>,
  deleted: boolean,
): number {
  const structured = canonicalLegacyImportJson(decisionStructured(fields, deleted));
  const content = deleted ? `Deleted decision ${String(fields.id)}` : synthesizeDecisionMemoryContent({
    decision: String(fields.decision ?? ""),
    choice: String(fields.choice ?? ""),
    rationale: String(fields.rationale ?? ""),
  });
  if (authority.kind === "memory") {
    return changes(getDb().prepare(`UPDATE memories
      SET content = :content, scope = :scope, structured_fields = :structured_fields, updated_at = :updated_at
      WHERE id = :memory_id`).run({
      ":content": content,
      ":scope": String(fields.scope ?? "project") || "project",
      ":structured_fields": structured,
      ":updated_at": occurredAt,
      ":memory_id": authority.memoryId,
    }));
  }
  const memoryId = `legacy-import-${hashLegacyImportValue({ operationId: context.operationId, decisionId: fields.id }).slice(7, 31)}`;
  return changes(getDb().prepare(`INSERT INTO memories (
      id, category, content, confidence, source_unit_type, source_unit_id,
      created_at, updated_at, superseded_by, hit_count, scope, tags, structured_fields
    ) VALUES (
      :id, 'architecture', :content, 0.85, NULL, NULL,
      :created_at, :updated_at, NULL, 0, :scope, '[]', :structured_fields
    )`).run({
    ":id": memoryId,
    ":content": content,
    ":created_at": occurredAt,
    ":updated_at": occurredAt,
    ":scope": String(fields.scope ?? "project") || "project",
    ":structured_fields": structured,
  }));
}

function applyDecision(
  context: Readonly<DomainOperationContext>,
  occurredAt: string,
  instruction: LegacyImportApplicationDecisionInstruction,
): LegacyImportApplicationInstructionResult {
  const authority = decisionAuthority(instruction.decisionId);
  let fields: Record<string, SqlValue>;
  let deleted = false;
  if (instruction.action === "create-decision-memory") {
    if (authority.kind === "legacy" || (authority.kind === "memory" && !authority.deleted)) {
      fail("legacy import decision already exists");
    }
    fields = { ...instruction.values };
  } else {
    if (authority.kind === "missing" || (authority.kind === "memory" && authority.deleted)) {
      fail("legacy import decision is missing");
    }
    fields = { ...authority.fields, ...instruction.values, id: instruction.decisionId };
    deleted = instruction.action === "delete-decision-memory";
  }
  if (fields.superseded_by === instruction.decisionId) fail("legacy import decision cannot supersede itself");
  const affected = writeDecisionMemory(context, occurredAt, authority, fields, deleted);
  if (affected !== 1) fail("legacy import decision memory mutation must affect exactly one row");
  return resultFor(instruction, 1, affected);
}

function adoptLifecycle(
  context: Readonly<DomainOperationContext>,
  occurredAt: string,
  instruction: Extract<LegacyImportApplicationPlanInstruction, { action: "adopt-lifecycle" }>,
): LegacyImportApplicationInstructionResult {
  const adopted = adoptLifecycleIfMissing(context, {
    itemKind: instruction.itemKind,
    milestoneId: instruction.milestoneId,
    ...(typeof instruction.sliceId === "string" ? { sliceId: instruction.sliceId } : {}),
    ...(typeof instruction.taskId === "string" ? { taskId: instruction.taskId } : {}),
    lifecycleStatus: instruction.lifecycleStatus,
    occurredAt,
  });
  if (instruction.lifecycleAction === "update") {
    if (adopted.adopted) fail("legacy import lifecycle shadow repair requires existing canonical authority");
    if (adopted.lifecycleStatus !== instruction.lifecycleStatus) {
      fail("legacy import lifecycle status does not match canonical authority");
    }
    return resultFor(instruction, 0, 0);
  }
  if (!adopted.adopted || adopted.stateVersion !== 0) {
    fail("legacy import lifecycle already exists or was not adopted exactly");
  }
  return resultFor(instruction, 1, 1);
}

function seedQualityGate(
  occurredAt: string,
  instruction: Extract<LegacyImportApplicationPlanInstruction, { action: "seed-quality-gate" }>,
): LegacyImportApplicationInstructionResult {
  // #1658: complete-slice hard-requires exactly one Q8 quality gate per slice,
  // so every imported slice mints the row the canonical seam would have left
  // behind — plan_slice seeds a pending scope:"slice" Q8 (insertGateRow), and
  // completeSliceHierarchy closes it with verdict "omitted" when no
  // Operational Readiness evidence exists. A legacy import carries no gate
  // evidence, so completed slices adopt the omitted shape; no gate_runs ledger
  // row is minted because no evaluation actually ran.
  const complete = instruction.gateStatus === "complete";
  const result = getDb().prepare(`
    INSERT INTO quality_gates (
      milestone_id, slice_id, gate_id, scope, task_id,
      status, verdict, rationale, findings, evaluated_at
    ) VALUES (
      :milestone_id, :slice_id, 'Q8', 'slice', '',
      :status, :verdict, :rationale, '', :evaluated_at
    )
  `).run({
    ":milestone_id": instruction.milestoneId,
    ":slice_id": instruction.sliceId,
    ":status": instruction.gateStatus,
    ":verdict": complete ? "omitted" : "",
    ":rationale": complete ? "Seeded by legacy import — no Operational Readiness evidence available" : "",
    ":evaluated_at": complete ? occurredAt : null,
  });
  const affected = changes(result);
  if (affected !== 1) fail("legacy import quality gate seed must affect exactly one row");
  return resultFor(instruction, 1, affected);
}

export function applyLegacyImportApplicationPlan(
  context: Readonly<DomainOperationContext>,
  plan: LegacyImportApplicationPlan,
): LegacyImportApplicationWriterResult {
  const snapshot = preflight(plan);
  const occurredAt = requireApplicationContext(context, snapshot);
  validatePostPlanDecisionGraph(snapshot);
  const instructionResults: LegacyImportApplicationInstructionResult[] = [];
  for (const instruction of snapshot.instructions) {
    if (instruction.action === "create" || instruction.action === "update" || instruction.action === "delete") {
      instructionResults.push(applyRow(instruction));
    } else if (instruction.action === "replace-slice-dependencies") {
      instructionResults.push(replaceDependencies(instruction));
    } else if (instruction.action === "delete-slice-dependencies") {
      instructionResults.push(deleteDependencies(instruction));
    } else if (instruction.action === "adopt-lifecycle") {
      instructionResults.push(adoptLifecycle(context, occurredAt, instruction));
    } else if (instruction.action === "seed-quality-gate") {
      instructionResults.push(seedQualityGate(occurredAt, instruction));
    } else if (
      instruction.action === "create-decision-memory"
      || instruction.action === "update-decision-memory"
      || instruction.action === "delete-decision-memory"
    ) {
      instructionResults.push(applyDecision(context, occurredAt, instruction));
    } else {
      instructionResults.push(resultFor(instruction, 0, 0));
    }
  }
  requireRetainedSliceDependencyIntegrity(snapshot.instructions);
  return Object.freeze({ instructionResults: Object.freeze(instructionResults) });
}

export function insertLegacyImportApplicationReceipt(
  context: Readonly<DomainOperationContext>,
  plan: LegacyImportApplicationPlan,
  preview: LegacyImportPreviewArtifact,
  backup: LegacyImportVerifiedBackup,
): void {
  const planSnapshot = preflight(plan);
  const evidence = detachReceiptEvidence(preview, backup);
  const appliedAt = requireApplicationContext(context, planSnapshot);
  requireReceiptEvidenceMatches(context, planSnapshot, evidence.preview, evidence.backup);

  const envelope = evidence.preview.preview;
  const result = getDb().prepare(`INSERT INTO workflow_import_applications (
      operation_id, project_id, import_kind, importer_version,
      preview_schema_version, preview_id, preview_hash,
      base_project_revision, base_authority_epoch, base_database_schema_version,
      source_set_hash, change_set_hash,
      create_count, update_count, delete_count, preserve_count, unparsed_count, unresolved_count,
      preview_json,
      backup_ref, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch, backup_quick_check, backup_verified_at,
      applied_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :import_kind, :importer_version,
      :preview_schema_version, :preview_id, :preview_hash,
      :base_project_revision, :base_authority_epoch, :base_database_schema_version,
      :source_set_hash, :change_set_hash,
      :create_count, :update_count, :delete_count, :preserve_count, :unparsed_count, :unresolved_count,
      :preview_json,
      :backup_ref, :backup_sha256, :backup_byte_size, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch, :backup_quick_check, :backup_verified_at,
      :applied_at, :resulting_project_revision, :resulting_authority_epoch
    )`).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":import_kind": envelope.import_kind,
    ":importer_version": envelope.importer_version,
    ":preview_schema_version": envelope.preview_schema_version,
    ":preview_id": envelope.preview_id,
    ":preview_hash": evidence.preview.preview_hash,
    ":base_project_revision": envelope.base_project_revision,
    ":base_authority_epoch": envelope.base_authority_epoch,
    ":base_database_schema_version": envelope.base_database_schema_version,
    ":source_set_hash": envelope.source_set_hash,
    ":change_set_hash": envelope.change_set_hash,
    ":create_count": envelope.counts.create,
    ":update_count": envelope.counts.update,
    ":delete_count": envelope.counts.delete,
    ":preserve_count": envelope.counts.preserve,
    ":unparsed_count": envelope.counts.unparsed,
    ":unresolved_count": envelope.counts.unresolved,
    ":preview_json": canonicalLegacyImportJson(envelope),
    ":backup_ref": evidence.backup.backup_ref,
    ":backup_sha256": evidence.backup.backup_sha256,
    ":backup_byte_size": evidence.backup.backup_byte_size,
    ":backup_schema_version": evidence.backup.backup_database_schema_version,
    ":backup_project_revision": evidence.backup.base_project_revision,
    ":backup_authority_epoch": evidence.backup.base_authority_epoch,
    ":backup_quick_check": evidence.backup.quick_check,
    ":backup_verified_at": evidence.backup.verified_at,
    ":applied_at": appliedAt,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
  if (changes(result) !== 1) {
    fail("legacy import Application receipt insertion must affect exactly one row");
  }
}
