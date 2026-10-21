// Project/App: gsd-pi
// File Purpose: Pure deterministic compilation of a sealed legacy Preview into exact Application work.

import type {
  LegacyImportPreviewCounts,
  LegacyImportPreviewEnvelope,
  LegacyImportSha256,
  LegacyImportTarget,
  LegacyImportValue,
} from "./legacy-import-contract.js";
import { compareText, deepFreeze } from "./legacy-import-utils.js";
import { LegacyImportApplicationError } from "./legacy-import-application-error.js";
import type { LegacyImportBaseRowSet } from "./legacy-import-preview-base.js";
import {
  LEGACY_IMPORT_BOOLEAN_COLUMNS,
  LEGACY_IMPORT_JSON_COLUMNS,
  LEGACY_IMPORT_TARGET_ADAPTERS,
  legacyImportTargetIdentity,
  type LegacyImportTargetAdapter,
} from "./legacy-import-preview-classifier-targets.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  isStrictLegacyImportData,
  isValidLegacyImportPreviewArtifact,
  type LegacyImportPreviewArtifact,
} from "./legacy-import-preview.js";
import {
  normalizeCanonicalLifecycleStatus,
  normalizeLegacyLifecycleStatus,
  type CanonicalLifecycleStatus,
} from "./db/lifecycle-shadow-comparison.js";

export const LEGACY_IMPORT_APPLICATION_PLAN_SCHEMA_VERSION = 2 as const;

type CanonicalTargetKind = keyof typeof LEGACY_IMPORT_TARGET_ADAPTERS;
type HierarchyKind = "milestone" | "slice" | "task";
type SqlValue = null | number | string;
type SqlRecord = Readonly<Record<string, SqlValue>>;

export interface LegacyImportApplicationRowInstruction {
  readonly action: "create" | "update" | "delete";
  readonly targetKind: Exclude<CanonicalTargetKind, "decision">;
  readonly targetKey: string;
  readonly rowSet: LegacyImportBaseRowSet;
  readonly identity: SqlRecord;
  readonly values: SqlRecord;
  readonly changeIds: readonly string[];
}

export interface LegacyImportApplicationDecisionInstruction {
  readonly action:
    | "create-decision-memory"
    | "update-decision-memory"
    | "delete-decision-memory";
  readonly targetKind: "decision";
  readonly targetKey: string;
  readonly decisionId: string;
  readonly values: SqlRecord;
  readonly changeIds: readonly string[];
}

export interface LegacyImportApplicationSliceDependenciesInstruction {
  readonly action: "replace-slice-dependencies";
  readonly targetKind: "slice-dependencies";
  readonly targetKey: string;
  readonly milestoneId: string;
  readonly sliceId: string;
  readonly dependsOnSliceIds: readonly string[];
  readonly changeIds: readonly string[];
}

export interface LegacyImportApplicationDeleteSliceDependenciesInstruction {
  readonly action: "delete-slice-dependencies";
  readonly targetKind: "slice-dependencies";
  readonly targetKey: string;
  readonly milestoneId: string;
  readonly sliceId: string;
  readonly changeIds: readonly string[];
}

export interface LegacyImportApplicationLifecycleInstruction {
  readonly action: "adopt-lifecycle";
  readonly lifecycleAction: "create" | "update";
  readonly targetKind: "milestone-lifecycle" | "slice-lifecycle" | "task-lifecycle";
  readonly targetKey: string;
  readonly itemKind: HierarchyKind;
  readonly milestoneId: string;
  readonly sliceId: string | null;
  readonly taskId: string | null;
  readonly lifecycleStatus: CanonicalLifecycleStatus;
  readonly changeIds: readonly string[];
}

export interface LegacyImportApplicationQualityGateInstruction {
  readonly action: "seed-quality-gate";
  readonly targetKind: "slice-quality-gate";
  readonly targetKey: string;
  readonly milestoneId: string;
  readonly sliceId: string;
  readonly gateStatus: "pending" | "complete";
  readonly changeIds: readonly string[];
}

export interface LegacyImportApplicationPreserveInstruction {
  readonly action: "preserve";
  readonly targetKind: string;
  readonly targetKey: string;
  readonly targetField?: string;
  readonly rowSet?: LegacyImportBaseRowSet;
  readonly identity?: SqlRecord;
  readonly values?: SqlRecord;
  readonly changeIds: readonly [string];
}

export type LegacyImportApplicationPlanInstruction =
  | LegacyImportApplicationRowInstruction
  | LegacyImportApplicationDecisionInstruction
  | LegacyImportApplicationSliceDependenciesInstruction
  | LegacyImportApplicationDeleteSliceDependenciesInstruction
  | LegacyImportApplicationLifecycleInstruction
  | LegacyImportApplicationQualityGateInstruction
  | LegacyImportApplicationPreserveInstruction;

export interface LegacyImportApplicationAffectedTarget {
  readonly targetKind: string;
  readonly targetKey: string;
}

export interface LegacyImportApplicationPlanAccounting {
  readonly sourceIds: readonly string[];
  readonly diagnosisIds: readonly string[];
  readonly resolutionIds: readonly string[];
  readonly changeIds: readonly string[];
  readonly preserveChangeIds: readonly string[];
  readonly unparsedSourceIds: readonly string[];
}

export interface LegacyImportApplicationMutationCounts {
  readonly create: number;
  readonly update: number;
  readonly delete: number;
  readonly replaceSliceDependencies: number;
  readonly deleteSliceDependencies: number;
  readonly adoptLifecycle: number;
  readonly seedQualityGate: number;
}

export interface LegacyImportApplicationEventFacts {
  readonly previewId: string;
  readonly previewHash: LegacyImportSha256;
  readonly sourceSetHash: LegacyImportSha256;
  readonly changeSetHash: LegacyImportSha256;
  readonly receiptCounts: Readonly<LegacyImportPreviewCounts>;
  readonly mutationCounts: Readonly<LegacyImportApplicationMutationCounts>;
  readonly affectedTargetHashes: readonly LegacyImportSha256[];
  readonly sourceCount: number;
  readonly diagnosisCount: number;
  readonly resolutionCount: number;
  readonly preserveCount: number;
  readonly unparsedCount: number;
}

export interface LegacyImportApplicationPlan {
  readonly planSchemaVersion: typeof LEGACY_IMPORT_APPLICATION_PLAN_SCHEMA_VERSION;
  readonly previewId: string;
  readonly previewHash: LegacyImportSha256;
  readonly baseProjectRevision: number;
  readonly baseAuthorityEpoch: number;
  readonly receiptCounts: Readonly<LegacyImportPreviewCounts>;
  readonly instructions: readonly LegacyImportApplicationPlanInstruction[];
  readonly accounting: Readonly<LegacyImportApplicationPlanAccounting>;
  readonly mutationCounts: Readonly<LegacyImportApplicationMutationCounts>;
  readonly affectedTargets: readonly LegacyImportApplicationAffectedTarget[];
  readonly eventFacts: Readonly<LegacyImportApplicationEventFacts>;
  readonly projectionKeys: readonly string[];
}

interface MutableRowClaim {
  action: "create" | "update" | "delete";
  targetKind: CanonicalTargetKind;
  targetKey: string;
  rowSet: LegacyImportBaseRowSet;
  identity: Record<string, SqlValue>;
  values: Record<string, SqlValue>;
  changeIds: string[];
}

interface PreparedTarget {
  kind: CanonicalTargetKind;
  key: string;
  adapter: LegacyImportTargetAdapter;
  identity: Record<string, SqlValue>;
  identityFields: Set<string>;
}

interface LifecycleShadowClaim {
  action: "create" | "update";
  prepared: PreparedTarget;
  values: Record<string, SqlValue>;
  changeId: string;
}

type MutableLifecycleInstruction = {
  -readonly [Key in keyof LegacyImportApplicationLifecycleInstruction]:
    LegacyImportApplicationLifecycleInstruction[Key] extends readonly string[]
      ? string[]
      : LegacyImportApplicationLifecycleInstruction[Key];
};

function fail(
  code: "LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID"
    | "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED"
    | "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
  message: string,
  context: Readonly<Record<string, LegacyImportValue>> = {},
): never {
  throw new LegacyImportApplicationError("compile", code, message, false, context);
}

function failUnresolved(preview: LegacyImportPreviewEnvelope): never {
  throw new LegacyImportApplicationError(
    "preview",
    "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED",
    "legacy import Preview requires a user-selected or unsupported resolution",
    false,
    { preview_id: preview.preview_id, unresolved_count: preview.counts.unresolved },
  );
}

function targetIdentityHash(kind: string, key: string): LegacyImportSha256 {
  return hashLegacyImportValue({ kind, key });
}

function safeTargetContext(
  kind: string,
  key: string,
  field?: string,
): Readonly<Record<string, LegacyImportValue>> {
  return {
    target_identity_hash: targetIdentityHash(kind, key),
    ...(field === undefined ? {} : { field_hash: hashLegacyImportValue(field) }),
  };
}

function isRecord(value: LegacyImportValue): value is Readonly<Record<string, LegacyImportValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePart(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", `${label} is not canonical non-blank text`);
  }
  return value;
}

function adapterFor(kind: string): { kind: CanonicalTargetKind; adapter: LegacyImportTargetAdapter } {
  const adapters = LEGACY_IMPORT_TARGET_ADAPTERS as Readonly<
    Partial<Record<string, LegacyImportTargetAdapter>>
  >;
  const adapter = adapters[kind];
  if (adapter === undefined) {
    fail(
      "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
      "legacy import Preview contains an unsupported mutation target",
      { target_kind_hash: hashLegacyImportValue(kind) },
    );
  }
  return { kind: kind as CanonicalTargetKind, adapter };
}

function preparedTarget(target: LegacyImportTarget): PreparedTarget {
  const { kind, adapter } = adapterFor(target.kind);
  try {
    const resolved = legacyImportTargetIdentity(adapter, target.key);
    return {
      kind,
      key: target.key,
      adapter,
      identity: { ...resolved.identity },
      identityFields: new Set(resolved.fields),
    };
  } catch {
    fail(
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      "legacy import target key is malformed",
      safeTargetContext(kind, target.key),
    );
  }
}

function normalizeSqlValue(rowSet: LegacyImportBaseRowSet, field: string, value: LegacyImportValue): SqlValue {
  const column = `${rowSet}.${field}`;
  if (LEGACY_IMPORT_JSON_COLUMNS.has(column)) {
    let parsed: LegacyImportValue = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value) as LegacyImportValue;
      } catch {
        fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", `legacy import ${column} is invalid JSON`);
      }
    }
    if (!isStrictLegacyImportData(parsed)) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", `legacy import ${column} is not strict JSON`);
    }
    return canonicalLegacyImportJson(parsed);
  }
  if (LEGACY_IMPORT_BOOLEAN_COLUMNS.has(column)) {
    if (value === true || value === 1) return 1;
    if (value === false || value === 0) return 0;
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", `legacy import ${column} is not boolean`);
  }
  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", `legacy import ${column} is not a scalar column`);
}

function validateIdentity(
  prepared: PreparedTarget,
  row: Readonly<Record<string, LegacyImportValue>>,
): void {
  for (const [field, expected] of Object.entries(prepared.identity)) {
    if (!Object.hasOwn(row, field)) continue;
    if (canonicalLegacyImportJson(row[field]) !== canonicalLegacyImportJson(expected)) {
      fail(
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
        "legacy import normalized identity disagrees with its target",
        safeTargetContext(prepared.kind, prepared.key, field),
      );
    }
  }
}

function rowPatch(
  prepared: PreparedTarget,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
): Record<string, SqlValue> {
  const input = target.field === undefined
    ? (() => {
      if (!isRecord(normalized)) {
        fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import whole-row mutation is not an object");
      }
      validateIdentity(prepared, normalized);
      return Object.entries(normalized);
    })()
    : [[target.field, normalized] as const];
  const patch: Record<string, SqlValue> = {};
  for (const [inputField, value] of input) {
    const field = prepared.adapter.aliases[inputField] ?? inputField;
    if (prepared.adapter.metadata.has(inputField)) {
      if (target.field !== undefined) {
        fail(
          "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
          "legacy import metadata cannot be a mutation target",
          safeTargetContext(prepared.kind, prepared.key, inputField),
        );
      }
      continue;
    }
    if (!prepared.adapter.fields.has(field)) {
      fail(
        "LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED",
        "legacy import Preview contains an unsupported mutation field",
        safeTargetContext(prepared.kind, prepared.key, inputField),
      );
    }
    if (prepared.identityFields.has(field)) {
      if (target.field !== undefined) {
        fail(
          "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
          "legacy import identity fields cannot be mutated independently",
          safeTargetContext(prepared.kind, prepared.key, field),
        );
      }
      continue;
    }
    if (
      field === "status"
      && (prepared.kind === "milestone" || prepared.kind === "slice" || prepared.kind === "task")
      && (
        typeof value !== "string"
        || normalizeAnyLifecycleStatus(value) === null
      )
    ) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import hierarchy status is unsupported");
    }
    const normalizedValue = normalizeSqlValue(prepared.adapter.rowSet, field, value);
    const existing = patch[field];
    if (
      existing !== undefined
      && canonicalLegacyImportJson(existing) !== canonicalLegacyImportJson(normalizedValue)
    ) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import aliases claim unequal values");
    }
    patch[field] = normalizedValue;
  }
  return patch;
}

function normalizedChangeIds(changeIds: readonly string[]): string[] {
  return [...new Set(changeIds)].sort(compareText);
}

function normalizeAnyLifecycleStatus(value: string): CanonicalLifecycleStatus | null {
  return normalizeCanonicalLifecycleStatus(value) ?? normalizeLegacyLifecycleStatus(value);
}

function lifecycleKind(kind: string, field: string | undefined): HierarchyKind | undefined {
  if (field === "status" && (kind === "milestone" || kind === "slice" || kind === "task")) return kind;
  if (kind === "milestone-status") return "milestone";
  if (kind === "slice-status") return "slice";
  if (kind === "task-status") return "task";
  return undefined;
}

function lifecycleIdentity(kind: HierarchyKind, key: string): {
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
} {
  const identity = preparedTarget({ kind, key }).identity;
  const milestoneId = kind === "milestone" ? identity["id"] : identity["milestone_id"];
  const sliceId = kind === "milestone" ? null : identity["slice_id"] ?? identity["id"];
  const taskId = kind === "task" ? identity["id"] : null;
  if (
    typeof milestoneId !== "string"
    || (sliceId !== null && typeof sliceId !== "string")
    || (taskId !== null && typeof taskId !== "string")
  ) {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import lifecycle identity is incomplete");
  }
  return { milestoneId, sliceId, taskId };
}

function normalizedLifecycleStatus(value: LegacyImportValue): CanonicalLifecycleStatus {
  const candidate = isRecord(value) ? value["status"] : value;
  if (typeof candidate !== "string") {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import lifecycle status is missing");
  }
  const status = normalizeAnyLifecycleStatus(candidate);
  if (status === null) {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import lifecycle status is unsupported");
  }
  return status;
}

function lifecycleAuxiliaryPatch(
  itemKind: HierarchyKind,
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
): { prepared: PreparedTarget; patch: Record<string, SqlValue> } | undefined {
  if (!isRecord(normalized)) return undefined;
  const prepared = preparedTarget({ kind: itemKind, key: target.key });
  validateIdentity(prepared, normalized);
  const withoutStatus: Record<string, LegacyImportValue> = {};
  for (const [field, value] of Object.entries(normalized)) {
    if (field !== "status") withoutStatus[field] = value;
  }
  const patch = rowPatch(prepared, { kind: itemKind, key: target.key }, withoutStatus);
  return Object.keys(patch).length === 0 ? undefined : { prepared, patch };
}

function mergeAction(
  current: MutableRowClaim["action"],
  next: MutableRowClaim["action"],
): MutableRowClaim["action"] {
  if (current === "delete" || next === "delete") {
    if (current === next) return "delete";
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import mixes delete with row writes");
  }
  return current === "create" || next === "create" ? "create" : "update";
}

function addRowClaim(
  rows: Map<string, MutableRowClaim>,
  prepared: PreparedTarget,
  action: MutableRowClaim["action"],
  values: Record<string, SqlValue>,
  changeId: string,
): void {
  const mapKey = `${prepared.adapter.rowSet}\0${prepared.key}`;
  const existing = rows.get(mapKey);
  if (existing === undefined) {
    rows.set(mapKey, {
      action,
      targetKind: prepared.kind,
      targetKey: prepared.key,
      rowSet: prepared.adapter.rowSet,
      identity: { ...prepared.identity },
      values: { ...values },
      changeIds: [changeId],
    });
    return;
  }
  if (canonicalLegacyImportJson(existing.identity) !== canonicalLegacyImportJson(prepared.identity)) {
    fail(
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      "legacy import changes disagree on one canonical row identity",
      safeTargetContext(prepared.kind, prepared.key),
    );
  }
  existing.action = mergeAction(existing.action, action);
  for (const [field, value] of Object.entries(values)) {
    if (
      Object.hasOwn(existing.values, field)
      && canonicalLegacyImportJson(existing.values[field]) !== canonicalLegacyImportJson(value)
    ) {
      fail(
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
        "legacy import changes claim unequal values for one canonical field",
        safeTargetContext(prepared.kind, prepared.key, field),
      );
    }
    existing.values[field] = value;
  }
  existing.changeIds.push(changeId);
}

function applyLifecycleShadowClaim(
  rows: Map<string, MutableRowClaim>,
  claim: LifecycleShadowClaim,
): void {
  const mapKey = `${claim.prepared.adapter.rowSet}\0${claim.prepared.key}`;
  const existing = rows.get(mapKey);
  if (existing === undefined) {
    if (claim.action === "update") {
      addRowClaim(rows, claim.prepared, "update", claim.values, claim.changeId);
    }
    return;
  }
  if (existing.action === "delete") {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import mixes lifecycle status with row deletion");
  }
  Object.assign(existing.values, claim.values);
  existing.changeIds.push(claim.changeId);
}

function validateEvidence(preview: LegacyImportPreviewEnvelope): void {
  const sources = new Map(preview.sources.map((source) => [source.source_id, source]));
  for (const diagnosis of preview.diagnoses) {
    const source = sources.get(diagnosis.source_id);
    const end = diagnosis.locator.end_byte ?? diagnosis.locator.start_byte;
    if (source === undefined || diagnosis.locator.start_byte > source.byte_size || end > source.byte_size) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import diagnosis locator is outside its source");
    }
  }
  for (const change of preview.changes) {
    const source = sources.get(change.raw.source_id);
    const end = change.raw.locator.end_byte ?? change.raw.locator.start_byte;
    if (
      source === undefined
      || change.provenance.source_id !== source.source_id
      || change.provenance.parser_id !== source.parser_id
      || change.provenance.parser_version !== source.parser_version
      || change.raw.locator.start_byte > source.byte_size
      || end > source.byte_size
    ) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import change provenance is inconsistent");
    }
    const { change_id: changeId, ...identity } = change;
    if (hashLegacyImportValue(identity) !== changeId) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import change identity is inconsistent");
    }
  }
}

function validatePhysicalRowIdentities(rows: readonly MutableRowClaim[]): void {
  const assessmentPaths = new Map<string, string>();
  for (const row of rows) {
    if (row.targetKind !== "assessment") continue;
    const path = row.identity["path"];
    if (typeof path !== "string") {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import assessment path identity is missing");
    }
    const existing = assessmentPaths.get(path);
    if (existing !== undefined && existing !== row.targetKey) {
      fail(
        "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
        "legacy import assessments claim one physical path for different logical identities",
      );
    }
    assessmentPaths.set(path, row.targetKey);
  }
}

function rowRank(rowSet: LegacyImportBaseRowSet): number {
  switch (rowSet) {
    case "milestones": return 0;
    case "slices": return 1;
    case "tasks": return 2;
    case "requirements": return 3;
    case "decisions": return 4;
    case "artifacts": return 5;
    case "assessments": return 6;
    default: return 7;
  }
}

function compareRows(left: MutableRowClaim, right: MutableRowClaim): number {
  return rowRank(left.rowSet) - rowRank(right.rowSet) || compareText(left.targetKey, right.targetKey);
}

function lifecycleRank(kind: HierarchyKind): number {
  return kind === "milestone" ? 0 : kind === "slice" ? 1 : 2;
}

const DECISION_DEFAULTS: Readonly<Record<string, SqlValue>> = {
  when_context: "",
  scope: "",
  decision: "",
  choice: "",
  rationale: "",
  revisable: "",
  made_by: "agent",
  source: "discussion",
  superseded_by: null,
};

function normalizedDecisionFields(
  id: string,
  value: Readonly<Record<string, LegacyImportValue>>,
): Record<string, SqlValue> {
  const adapter = LEGACY_IMPORT_TARGET_ADAPTERS.decision;
  const result: Record<string, SqlValue> = { id, ...DECISION_DEFAULTS };
  for (const field of adapter.fields) {
    if (field === "id" || !Object.hasOwn(value, field)) continue;
    result[field] = normalizeSqlValue("decisions", field, value[field]);
  }
  return result;
}

function rowInstruction(
  row: MutableRowClaim,
): LegacyImportApplicationRowInstruction | LegacyImportApplicationDecisionInstruction {
  const values = row.action === "create"
    ? { ...row.identity, ...row.values }
    : row.action === "delete" ? {} : row.values;
  const changeIds = normalizedChangeIds(row.changeIds);
  if (row.targetKind === "decision") {
    return {
      action: `${row.action}-decision-memory`,
      targetKind: "decision",
      targetKey: row.targetKey,
      decisionId: row.targetKey,
      values: row.action === "create"
        ? normalizedDecisionFields(row.targetKey, values)
        : values,
      changeIds,
    };
  }
  return {
    action: row.action,
    targetKind: row.targetKind as Exclude<CanonicalTargetKind, "decision">,
    targetKey: row.targetKey,
    rowSet: row.rowSet,
    identity: row.identity,
    values,
    changeIds,
  };
}

function sliceDependencies(
  rows: readonly MutableRowClaim[],
): Array<LegacyImportApplicationSliceDependenciesInstruction | LegacyImportApplicationDeleteSliceDependenciesInstruction> {
  const instructions: Array<
    LegacyImportApplicationSliceDependenciesInstruction | LegacyImportApplicationDeleteSliceDependenciesInstruction
  > = [];
  for (const row of rows) {
    if (row.targetKind !== "slice") continue;
    const milestoneId = row.identity["milestone_id"];
    const sliceId = row.identity["id"];
    if (typeof milestoneId !== "string" || typeof sliceId !== "string") {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import slice identity is incomplete");
    }
    if (row.action === "delete") {
      instructions.push({
        action: "delete-slice-dependencies",
        targetKind: "slice-dependencies",
        targetKey: row.targetKey,
        milestoneId,
        sliceId,
        changeIds: normalizedChangeIds(row.changeIds),
      });
      continue;
    }
    if (!Object.hasOwn(row.values, "depends")) continue;
    const encoded = row.values["depends"];
    if (typeof encoded !== "string") {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import slice dependencies are invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import slice dependencies are invalid JSON");
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import slice dependencies are not string IDs");
    }
    const dependsOnSliceIds = [...new Set(parsed.map((value) => requirePart(value, "slice dependency")))]
      .sort(compareText);
    if (dependsOnSliceIds.includes(sliceId)) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import slice cannot depend on itself");
    }
    instructions.push({
      action: "replace-slice-dependencies",
      targetKind: "slice-dependencies",
      targetKey: row.targetKey,
      milestoneId,
      sliceId,
      dependsOnSliceIds,
      changeIds: normalizedChangeIds(row.changeIds),
    });
  }
  return instructions.sort((left, right) => compareText(left.targetKey, right.targetKey));
}

function validateAssessment(prepared: PreparedTarget, normalized: LegacyImportValue, action: string): void {
  if (action === "delete" || !isRecord(normalized)) {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import assessment mutation is incomplete");
  }
  if (
    normalized["authority"] !== "structured"
    || typeof normalized["path"] !== "string"
    || normalized["path"].trim().length === 0
    || typeof normalized["full_content"] !== "string"
    || normalized["full_content"].trim().length === 0
  ) {
    fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import assessment lacks deterministic authority");
  }
  validateIdentity(prepared, normalized);
  prepared.identity["path"] = normalized["path"];
  prepared.identityFields.add("path");
}

function addLifecycleClaim(
  instructions: Map<string, MutableLifecycleInstruction>,
  value: LegacyImportApplicationLifecycleInstruction,
): void {
  const key = `${value.itemKind}\0${value.targetKey}`;
  const existing = instructions.get(key);
  if (existing === undefined) {
    instructions.set(key, { ...value, changeIds: [...value.changeIds] });
    return;
  }
  if (existing.lifecycleStatus !== value.lifecycleStatus) {
    fail(
      "LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT",
      "legacy import lifecycle changes claim unequal statuses",
      safeTargetContext(value.itemKind, value.targetKey, "lifecycle_status"),
    );
  }
  if (value.lifecycleAction === "create") existing.lifecycleAction = "create";
  existing.changeIds.push(...value.changeIds);
}

function projections(
  previewId: string,
  instructions: readonly LegacyImportApplicationPlanInstruction[],
): string[] {
  const values = new Map<string, string>();
  function add(value: string): void {
    const canonical = value.toLowerCase();
    const existing = values.get(canonical);
    if (existing !== undefined && existing !== value) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import projection identities case-fold collide");
    }
    values.set(canonical, value);
  }
  add(`legacy-import/${previewId}`);
  for (const instruction of instructions) {
    if (instruction.action === "preserve") continue;
    if (
      instruction.targetKind === "milestone"
      || instruction.targetKind === "slice"
      || instruction.targetKind === "task"
    ) add(`planning/${instruction.targetKey}`);
    if (instruction.targetKind === "requirement") add("planning/requirements");
    if (instruction.targetKind === "decision") add("planning/decisions");
    if (instruction.action === "adopt-lifecycle") add(`lifecycle/${instruction.targetKey}`);
  }
  return [...values.keys()];
}

/**
 * Lifecycle projection keys must carry the same projection kind the canonical
 * lifecycle domain operations enqueue, because trg_workflow_projection_lineage
 * refuses to extend a (project, key) chain across a kind change. Importing
 * lifecycle keys as "markdown" left post-import closeouts unable to enqueue
 * their slice/task lifecycle projections (#1659). The key-family → kind
 * mapping lives in projection-identity.ts as the single authority (#1661);
 * this alias is the import surface's name for it.
 */
export { canonicalProjectionKind as legacyImportProjectionKind } from "./projection-identity.js";

export function compileLegacyImportApplicationPlan(value: unknown): LegacyImportApplicationPlan {
  if (!isStrictLegacyImportData(value)) {
    fail("LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID", "legacy import compiler requires strict Preview data");
  }
  let artifact: LegacyImportPreviewArtifact;
  try {
    artifact = structuredClone(value) as LegacyImportPreviewArtifact;
  } catch {
    fail("LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID", "legacy import compiler could not detach the Preview");
  }
  if (!isValidLegacyImportPreviewArtifact(artifact)) {
    fail("LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID", "legacy import compiler received an invalid sealed Preview");
  }
  const preview = artifact.preview;
  if (
    preview.counts.unresolved !== 0
    || preview.resolutions.some((resolution) => (
      resolution.disposition === "requires-user" || resolution.disposition === "unsupported"
    ))
  ) failUnresolved(preview);
  validateEvidence(preview);

  const rows = new Map<string, MutableRowClaim>();
  const lifecycleClaims = new Map<string, MutableLifecycleInstruction>();
  const lifecycleShadowClaims: LifecycleShadowClaim[] = [];
  const preserves: LegacyImportApplicationPreserveInstruction[] = [];
  const preserveChangeIds: string[] = [];
  for (const change of preview.changes) {
    if (change.action === "preserve") {
      preserveChangeIds.push(change.change_id);
      const adapter = (LEGACY_IMPORT_TARGET_ADAPTERS as Readonly<
        Partial<Record<string, LegacyImportTargetAdapter>>
      >)[change.target.kind];
      const exactRow = adapter !== undefined
        && change.target.field === undefined
        && isRecord(change.normalized)
        && Object.keys(change.normalized).every((field) => (
          adapter.fields.has(adapter.aliases[field] ?? field) || adapter.metadata.has(field)
        ))
        ? (() => {
          const prepared = preparedTarget(change.target);
          return {
            rowSet: prepared.adapter.rowSet,
            identity: prepared.identity,
            values: { ...prepared.identity, ...rowPatch(prepared, change.target, change.normalized) },
          };
        })()
        : {};
      preserves.push({
        action: "preserve",
        targetKind: change.target.kind,
        targetKey: change.target.key,
        ...(change.target.field === undefined ? {} : { targetField: change.target.field }),
        ...exactRow,
        changeIds: [change.change_id],
      });
      continue;
    }
    const itemKind = lifecycleKind(change.target.kind, change.target.field);
    if (itemKind !== undefined) {
      if (change.action === "delete") {
        fail("LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED", "legacy import cannot delete durable lifecycle authority");
      }
      if (change.action !== "create" && change.action !== "update") {
        fail("LEGACY_IMPORT_APPLICATION_MAPPING_UNSUPPORTED", "legacy import lifecycle action is unsupported");
      }
      const identity = lifecycleIdentity(itemKind, change.target.key);
      const lifecycleStatus = normalizedLifecycleStatus(change.normalized);
      const status = isRecord(change.normalized) ? change.normalized["status"] : change.normalized;
      const shadowTarget = { kind: itemKind, key: change.target.key, field: "status" };
      const shadowPrepared = preparedTarget(shadowTarget);
      lifecycleShadowClaims.push({
        action: change.action,
        prepared: shadowPrepared,
        values: rowPatch(shadowPrepared, shadowTarget, status),
        changeId: change.change_id,
      });
      const auxiliary = lifecycleAuxiliaryPatch(itemKind, change.target, change.normalized);
      if (auxiliary !== undefined) {
        addRowClaim(rows, auxiliary.prepared, "update", auxiliary.patch, change.change_id);
      }
      addLifecycleClaim(lifecycleClaims, {
        action: "adopt-lifecycle",
        lifecycleAction: change.action,
        targetKind: `${itemKind}-lifecycle`,
        targetKey: change.target.key,
        itemKind,
        ...identity,
        lifecycleStatus,
        changeIds: [change.change_id],
      });
      continue;
    }

    const prepared = preparedTarget(change.target);
    if (prepared.kind === "assessment") validateAssessment(prepared, change.normalized, change.action);
    if (change.action === "delete") {
      if (
        change.target.field !== undefined
        || change.normalized !== null
        || change.reason_code !== "complete-snapshot-row-absent"
      ) {
        fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import delete lacks complete-set evidence");
      }
      addRowClaim(rows, prepared, "delete", {}, change.change_id);
      continue;
    }
    const patch = rowPatch(prepared, change.target, change.normalized);
    if (change.action === "update" && Object.keys(patch).length === 0) {
      fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import update has no writable fields");
    }
    addRowClaim(rows, prepared, change.action, patch, change.change_id);
  }

  for (const claim of lifecycleShadowClaims) applyLifecycleShadowClaim(rows, claim);

  // Companion-authority pass: an import that creates a hierarchy row must also
  // mint the canonical companion rows that the workflow engine hard-requires
  // beside it, or a recover-imported tree wedges auto mode at slice closeout.
  //   #1657: execute-task and complete-slice require workflow_item_lifecycles
  //   rows. Derive an adoption for every hierarchy create that has no explicit
  //   lifecycle claim; explicit status evidence keeps authority. The status
  //   mapping mirrors the planning adoption seam (milestone-planning-persistence):
  //   terminal statuses adopt as-is, in-flight work adopts as "ready".
  //   #1658: complete-slice requires exactly one Q8 quality gate per slice
  //   (pending while open — the row plan_slice seeds; complete once closed —
  //   the state completeSliceHierarchy leaves behind). Derive one Q8 claim per
  //   created slice, mirroring whichever lifecycle authority won above.
  const qualityGateClaims: LegacyImportApplicationQualityGateInstruction[] = [];
  for (const row of rows.values()) {
    if (row.action !== "create") continue;
    const itemKind = lifecycleKind(row.targetKind, "status");
    if (itemKind === undefined) continue;
    const status = row.values["status"];
    const normalized = typeof status === "string"
      ? normalizeAnyLifecycleStatus(status)
      : null;
    const identity = lifecycleIdentity(itemKind, row.targetKey);
    if (!lifecycleClaims.has(`${itemKind}\0${row.targetKey}`)) {
      addLifecycleClaim(lifecycleClaims, {
        action: "adopt-lifecycle",
        lifecycleAction: "create",
        targetKind: `${itemKind}-lifecycle`,
        targetKey: row.targetKey,
        itemKind,
        ...identity,
        lifecycleStatus: normalized === "completed" || normalized === "cancelled" ? normalized : "ready",
        changeIds: row.changeIds,
      });
    }
    if (itemKind === "slice") {
      const lifecycleStatus = lifecycleClaims.get(`slice\0${row.targetKey}`)?.lifecycleStatus;
      if (identity.sliceId === null) {
        fail("LEGACY_IMPORT_APPLICATION_MAPPING_INCONSISTENT", "legacy import slice quality gate identity is incomplete");
      }
      qualityGateClaims.push({
        action: "seed-quality-gate",
        targetKind: "slice-quality-gate",
        targetKey: row.targetKey,
        milestoneId: identity.milestoneId,
        sliceId: identity.sliceId,
        gateStatus: lifecycleStatus === "completed" ? "complete" : "pending",
        changeIds: row.changeIds,
      });
    }
  }

  const rowValues = [...rows.values()];
  validatePhysicalRowIdentities(rowValues);
  const nonDeletes = rowValues.filter((row) => row.action !== "delete").sort(compareRows);
  const deletes = rowValues.filter((row) => row.action === "delete").sort((left, right) => (
    compareRows(right, left)
  ));
  const dependencies = sliceDependencies(rowValues);
  const dependencyWrites = dependencies.filter((entry) => entry.action === "replace-slice-dependencies");
  const dependencyDeletes = dependencies.filter((entry) => entry.action === "delete-slice-dependencies");
  const lifecycle = [...lifecycleClaims.values()]
    .map((instruction) => ({
      ...instruction,
      changeIds: normalizedChangeIds(instruction.changeIds),
    }))
    .sort((left, right) => (
      lifecycleRank(left.itemKind) - lifecycleRank(right.itemKind)
      || compareText(left.targetKey, right.targetKey)
    ));
  const qualityGates = qualityGateClaims
    .map((instruction) => ({ ...instruction, changeIds: normalizedChangeIds(instruction.changeIds) }))
    .sort((left, right) => compareText(left.targetKey, right.targetKey));
  const instructions: LegacyImportApplicationPlanInstruction[] = [
    ...nonDeletes.map(rowInstruction),
    ...dependencyWrites,
    ...lifecycle,
    ...qualityGates,
    ...dependencyDeletes,
    ...deletes.map(rowInstruction),
    ...preserves,
  ];
  const mutationCounts: LegacyImportApplicationMutationCounts = {
    create: rowValues.filter((row) => row.action === "create").length,
    update: rowValues.filter((row) => row.action === "update").length,
    delete: rowValues.filter((row) => row.action === "delete").length,
    replaceSliceDependencies: dependencyWrites.length,
    deleteSliceDependencies: dependencyDeletes.length,
    adoptLifecycle: lifecycle.length,
    seedQualityGate: qualityGates.length,
  };
  const affectedTargets: LegacyImportApplicationAffectedTarget[] = [];
  const affected = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.action === "preserve") continue;
    const identity = `${instruction.targetKind}\0${instruction.targetKey}`;
    if (affected.has(identity)) continue;
    affected.add(identity);
    affectedTargets.push({ targetKind: instruction.targetKind, targetKey: instruction.targetKey });
  }
  const receiptCounts = { ...preview.counts };
  const accounting: LegacyImportApplicationPlanAccounting = {
    sourceIds: preview.sources.map((source) => source.source_id),
    diagnosisIds: preview.diagnoses.map((diagnosis) => diagnosis.diagnosis_id),
    resolutionIds: preview.resolutions.map((resolution) => resolution.diagnosis_id),
    changeIds: preview.changes.map((change) => change.change_id),
    preserveChangeIds,
    unparsedSourceIds: preview.sources
      .filter((source) => source.outcome === "unparsed")
      .map((source) => source.source_id),
  };
  const eventFacts: LegacyImportApplicationEventFacts = {
    previewId: preview.preview_id,
    previewHash: artifact.preview_hash,
    sourceSetHash: preview.source_set_hash,
    changeSetHash: preview.change_set_hash,
    receiptCounts,
    mutationCounts,
    affectedTargetHashes: affectedTargets.map((target) => (
      targetIdentityHash(target.targetKind, target.targetKey)
    )),
    sourceCount: preview.sources.length,
    diagnosisCount: preview.diagnoses.length,
    resolutionCount: preview.resolutions.length,
    preserveCount: receiptCounts.preserve,
    unparsedCount: receiptCounts.unparsed,
  };
  return deepFreeze({
    planSchemaVersion: LEGACY_IMPORT_APPLICATION_PLAN_SCHEMA_VERSION,
    previewId: preview.preview_id,
    previewHash: artifact.preview_hash,
    baseProjectRevision: preview.base_project_revision,
    baseAuthorityEpoch: preview.base_authority_epoch,
    receiptCounts,
    instructions,
    accounting,
    mutationCounts,
    affectedTargets,
    eventFacts,
    projectionKeys: projections(preview.preview_id, instructions),
  });
}
