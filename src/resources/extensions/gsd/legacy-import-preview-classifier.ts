// Project/App: gsd-pi
// File Purpose: Deterministic classification boundary for legacy import Preview candidates.

import { compareText, deepFreeze } from "./legacy-import-utils.js";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportPreviewChange,
  type LegacyImportPreviewCounts,
  type LegacyImportPreviewDiagnosis,
  type LegacyImportPreviewResolution,
  type LegacyImportPreviewSource,
  type LegacyImportSha256,
  type LegacyImportTarget,
  type LegacyImportValue,
} from "./legacy-import-contract.js";
import type {
  LegacyImportBaseRowSet,
  LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import type {
  LegacyImportCompleteRowSet,
  LegacyImportInterpretation,
  LegacyImportInterpretationCandidate,
} from "./legacy-import-preview-interpretation.js";
import {
  LEGACY_IMPORT_BOOLEAN_COLUMNS,
  LEGACY_IMPORT_COMPLETE_TARGET_KINDS,
  LEGACY_IMPORT_JSON_COLUMNS,
  LEGACY_IMPORT_TARGET_ADAPTERS,
  legacyImportTargetIdentity,
  type LegacyImportTargetAdapter,
} from "./legacy-import-preview-classifier-targets.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
} from "./legacy-import-preview.js";
import {
  compareLifecycleShadow,
  normalizeCanonicalLifecycleStatus,
  normalizeLegacyLifecycleStatus,
} from "./db/lifecycle-shadow-comparison.js";

export interface LegacyImportClassification {
  applicable: boolean;
  sources: readonly LegacyImportPreviewSource[];
  changes: readonly LegacyImportPreviewChange[];
  diagnoses: readonly LegacyImportPreviewDiagnosis[];
  resolutions: readonly LegacyImportPreviewResolution[];
  counts: LegacyImportPreviewCounts;
  source_set_hash: LegacyImportSha256;
  change_set_hash: LegacyImportSha256;
}

export type LegacyImportClassificationErrorCode =
  | "LEGACY_IMPORT_CLASSIFICATION_BASE_INCONSISTENT"
  | "LEGACY_IMPORT_CLASSIFICATION_SOURCE_INCONSISTENT"
  | "LEGACY_IMPORT_CLASSIFICATION_CANDIDATE_INCONSISTENT"
  | "LEGACY_IMPORT_CLASSIFICATION_TARGET_UNSUPPORTED"
  | "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID"
  | "LEGACY_IMPORT_CLASSIFICATION_DECISION_AUTHORITY_INVALID"
  | "LEGACY_IMPORT_CLASSIFICATION_LIFECYCLE_AUTHORITY_INVALID"
  | "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID"
  | "LEGACY_IMPORT_CLASSIFICATION_DIAGNOSIS_RESOLUTION_INVALID"
  | "LEGACY_IMPORT_CLASSIFICATION_CHANGE_ID_COLLISION";

export class LegacyImportClassificationError extends Error {
  readonly stage = "classification";
  readonly retryable = false;
  readonly code: LegacyImportClassificationErrorCode;
  readonly context: Readonly<Record<string, LegacyImportValue>>;

  constructor(
    code: LegacyImportClassificationErrorCode,
    message: string,
    context: Readonly<Record<string, LegacyImportValue>> = {},
  ) {
    super(message);
    this.name = "LegacyImportClassificationError";
    this.code = code;
    this.context = context;
  }
}

type JsonRecord = Record<string, LegacyImportValue>;
type HierarchyKind = "milestone" | "slice" | "task";

interface TargetAddress {
  rowSet: LegacyImportBaseRowSet;
  identity: string;
  memberKey: string;
  field?: string;
  hierarchyAddress?: string;
}

interface PreparedCandidate {
  candidate: LegacyImportInterpretationCandidate;
  address: TargetAddress;
  patch: JsonRecord;
}

interface AmbiguityEvidence {
  raw: LegacyImportInterpretationCandidate["raw"];
  stableId: string;
}

function fail(
  code: LegacyImportClassificationErrorCode,
  message: string,
  context: Readonly<Record<string, LegacyImportValue>> = {},
): never {
  throw new LegacyImportClassificationError(code, message, context);
}

function asRecord(value: LegacyImportValue, label: string): JsonRecord {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
      `${label} must be a JSON object`,
      { label },
    );
  }
  return value as JsonRecord;
}

function rowAddress(rowSet: LegacyImportBaseRowSet, rowIdentity: string): string {
  return `${rowSet}\0${rowIdentity}`;
}

function memberKey(rowSet: LegacyImportBaseRowSet, value: Readonly<JsonRecord>): string {
  switch (rowSet) {
    case "milestones":
    case "requirements":
    case "decisions": return String(value.id);
    case "slices": return `${String(value.milestone_id)}/${String(value.id)}`;
    case "tasks": return `${String(value.milestone_id)}/${String(value.slice_id)}/${String(value.id)}`;
    case "artifacts": return String(value.path);
    case "assessments": return completeMemberKey(rowSet, value);
    default:
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        `legacy import row set ${rowSet} cannot authorize deletes`,
        { row_set: rowSet },
      );
  }
}

function requiredStringIdentity(
  rowSet: LegacyImportBaseRowSet,
  value: Readonly<JsonRecord>,
  field: string,
): string {
  const identity = value[field];
  if (typeof identity !== "string" || identity.trim().length === 0) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      `legacy import complete ${rowSet} row ${field} identity must be a nonblank string`,
      { row_set: rowSet, field },
    );
  }
  return identity;
}

function optionalStringIdentity(
  rowSet: LegacyImportBaseRowSet,
  value: Readonly<JsonRecord>,
  field: string,
): string | null {
  const identity = value[field];
  if (identity === null || identity === undefined) return null;
  return requiredStringIdentity(rowSet, value, field);
}

function completeMemberKey(
  rowSet: LegacyImportBaseRowSet,
  value: Readonly<JsonRecord>,
): string {
  switch (rowSet) {
    case "milestones":
    case "requirements":
    case "decisions":
      return requiredStringIdentity(rowSet, value, "id");
    case "slices":
      return [
        requiredStringIdentity(rowSet, value, "milestone_id"),
        requiredStringIdentity(rowSet, value, "id"),
      ].join("/");
    case "tasks":
      return [
        requiredStringIdentity(rowSet, value, "milestone_id"),
        requiredStringIdentity(rowSet, value, "slice_id"),
        requiredStringIdentity(rowSet, value, "id"),
      ].join("/");
    case "artifacts":
      return requiredStringIdentity(rowSet, value, "path");
    case "assessments": {
      const milestoneId = requiredStringIdentity(rowSet, value, "milestone_id");
      const sliceId = optionalStringIdentity(rowSet, value, "slice_id");
      const taskId = optionalStringIdentity(rowSet, value, "task_id");
      const scope = requiredStringIdentity(rowSet, value, "scope");
      if (taskId !== null && sliceId === null) {
        fail(
          "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
          "legacy import complete assessment task identity requires a slice identity",
        );
      }
      return [milestoneId, sliceId, taskId, scope]
        .filter((part): part is string => part !== null)
        .join("/");
    }
    default:
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        `legacy import row set ${rowSet} cannot authorize deletes`,
        { row_set: rowSet },
      );
  }
}

function normalizeStoredValue(rowSet: LegacyImportBaseRowSet, field: string, value: LegacyImportValue): LegacyImportValue {
  const column = `${rowSet}.${field}`;
  if (LEGACY_IMPORT_BOOLEAN_COLUMNS.has(column) && (value === 0 || value === 1)) return value === 1;
  if (!LEGACY_IMPORT_JSON_COLUMNS.has(column) || typeof value !== "string") return value;
  try {
    return JSON.parse(value) as LegacyImportValue;
  } catch {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_BASE_INCONSISTENT",
      `legacy import base ${rowSet}.${field} is not valid JSON`,
      { row_set: rowSet, field },
    );
  }
}

function validateBase(base: LegacyImportBaseSnapshot): void {
  if (
    base.snapshot_schema_version !== 1
    || base.database_schema_version !== LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION
    || hashLegacyImportValue(base.rows) !== base.relevant_rows_hash
  ) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_BASE_INCONSISTENT",
      "legacy import classification base identity is inconsistent",
    );
  }
}

function validateSources(
  sources: readonly LegacyImportPreviewSource[],
): { ordered: LegacyImportPreviewSource[]; byId: Map<string, LegacyImportPreviewSource> } {
  const ordered = [...sources].sort((left, right) => (
    compareText(left.path, right.path) || compareText(left.source_id, right.source_id)
  ));
  const byId = new Map<string, LegacyImportPreviewSource>();
  const paths = new Set<string>();
  for (const source of ordered) {
    if (byId.has(source.source_id) || paths.has(source.path)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_SOURCE_INCONSISTENT",
        "legacy import classification sources are duplicated",
        { source_id: source.source_id, path: source.path },
      );
    }
    byId.set(source.source_id, source);
    paths.add(source.path);
  }
  return { ordered, byId };
}

function validateProvenance(
  sourceId: string,
  parserId: string,
  parserVersion: string,
  sources: ReadonlyMap<string, LegacyImportPreviewSource>,
): void {
  const source = sources.get(sourceId);
  if (
    source === undefined
    || source.parser_id !== parserId
    || source.parser_version !== parserVersion
  ) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_SOURCE_INCONSISTENT",
      "legacy import evidence provenance does not match its source",
      { source_id: sourceId },
    );
  }
}

function validateCandidate(
  candidate: LegacyImportInterpretationCandidate,
  sources: ReadonlyMap<string, LegacyImportPreviewSource>,
): void {
  const { candidate_id: candidateId, ordinal: _ordinal, ...pending } = candidate;
  if (hashLegacyImportValue(pending) !== candidateId) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_CANDIDATE_INCONSISTENT",
      "legacy import candidate identity is inconsistent",
      { candidate_id: candidateId },
    );
  }
  if (candidate.raw.source_id !== candidate.provenance.source_id) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_CANDIDATE_INCONSISTENT",
      "legacy import candidate raw evidence and provenance disagree",
      { candidate_id: candidateId },
    );
  }
  validateProvenance(
    candidate.provenance.source_id,
    candidate.provenance.parser_id,
    candidate.provenance.parser_version,
    sources,
  );
}

function validateDiagnosisResolutionBijection(
  diagnoses: readonly LegacyImportPreviewDiagnosis[],
  resolutions: readonly LegacyImportPreviewResolution[],
): void {
  const diagnosisIds = new Set<string>();
  for (const diagnosis of diagnoses) {
    if (diagnosisIds.has(diagnosis.diagnosis_id)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_DIAGNOSIS_RESOLUTION_INVALID",
        "duplicate legacy import diagnosis",
        { diagnosis_id: diagnosis.diagnosis_id },
      );
    }
    diagnosisIds.add(diagnosis.diagnosis_id);
  }
  const resolutionIds = new Set<string>();
  for (const resolution of resolutions) {
    if (resolutionIds.has(resolution.diagnosis_id)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_DIAGNOSIS_RESOLUTION_INVALID",
        "duplicate legacy import resolution",
        { diagnosis_id: resolution.diagnosis_id },
      );
    }
    if (!diagnosisIds.has(resolution.diagnosis_id)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_DIAGNOSIS_RESOLUTION_INVALID",
        "orphan legacy import resolution",
        { diagnosis_id: resolution.diagnosis_id },
      );
    }
    resolutionIds.add(resolution.diagnosis_id);
  }
  if (resolutionIds.size !== diagnosisIds.size) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_DIAGNOSIS_RESOLUTION_INVALID",
      "every legacy import diagnosis requires exactly one resolution",
    );
  }
}

function buildBaseRows(base: LegacyImportBaseSnapshot): Map<string, JsonRecord> {
  const rows = new Map<string, JsonRecord>();
  const decisionRows = new Map<string, JsonRecord>();
  const decisionMemories: JsonRecord[] = [];
  for (const row of base.rows) {
    if (row.row_set === "decision_memories") {
      decisionMemories.push({ ...row.value });
      continue;
    }
    const key = rowAddress(row.row_set, row.identity);
    if (rows.has(key)) {
      fail("LEGACY_IMPORT_CLASSIFICATION_BASE_INCONSISTENT", "legacy import base row identity is duplicated");
    }
    const value = { ...row.value };
    rows.set(key, value);
    if (row.row_set === "decisions") decisionRows.set(String(value.id), value);
  }

  for (const memory of decisionMemories) {
    const id = memory.source_decision_id;
    const structured = memory.structured_fields;
    if (typeof id !== "string" || typeof structured !== "string") {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_DECISION_AUTHORITY_INVALID",
        "legacy import decision memory authority is malformed",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(structured);
    } catch {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_DECISION_AUTHORITY_INVALID",
        "legacy import decision memory structured_fields is malformed",
        { decision_id: id },
      );
    }
    const fields = asRecord(parsed as LegacyImportValue, "decision memory structured_fields");
    if (fields.sourceDecisionId !== id) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_DECISION_AUTHORITY_INVALID",
        "legacy import decision memory identity is inconsistent",
        { decision_id: id },
      );
    }
    const decisionIdentity = canonicalLegacyImportJson({ id });
    if (fields.deleted === true) {
      decisionRows.delete(id);
      rows.delete(rowAddress("decisions", decisionIdentity));
      continue;
    }
    const effective = { ...(decisionRows.get(id) ?? { id }) };
    for (const field of LEGACY_IMPORT_TARGET_ADAPTERS.decision.fields) {
      if (field === "id") continue;
      const memoryField = fields[field];
      if (memoryField !== undefined) effective[field] = memoryField;
    }
    rows.set(rowAddress("decisions", decisionIdentity), effective);
  }
  return rows;
}

function validateNormalizedIdentity(
  kind: string,
  expected: Readonly<JsonRecord>,
  normalized: Readonly<JsonRecord>,
  requireEveryField: boolean,
  errorCode: LegacyImportClassificationErrorCode = "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (requireEveryField && !Object.hasOwn(normalized, field)) {
      fail(
        errorCode,
        `legacy import ${kind} normalized row is missing identity field ${field}`,
        { target_kind: kind, field },
      );
    }
    if (
      (requireEveryField || normalized[field] !== undefined)
      && canonicalLegacyImportJson(normalized[field]) !== canonicalLegacyImportJson(expectedValue)
    ) {
      fail(
        errorCode,
        `legacy import ${kind} normalized identity disagrees with its target`,
        { target_kind: kind, field, expected: expectedValue, actual: normalized[field] },
      );
    }
  }
}

function normalizedStatusCandidate(value: LegacyImportValue): string {
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    return normalizeStatus((value as JsonRecord).status);
  }
  return normalizeStatus(value);
}

function asHierarchyKind(value: string): HierarchyKind | undefined {
  if (value === "milestone" || value === "slice" || value === "task") return value;
  return undefined;
}

function targetAddress(
  base: LegacyImportBaseSnapshot,
  candidate: LegacyImportInterpretationCandidate,
): { address: TargetAddress; normalized: JsonRecord } {
  const { target } = candidate;
  const hierarchyStatusField = target.field === "status"
    && (target.kind === "milestone" || target.kind === "slice" || target.kind === "task");
  if (target.kind.endsWith("-status") || hierarchyStatusField) {
    const itemKindValue = hierarchyStatusField
      ? target.kind
      : target.kind.slice(0, -"-status".length);
    const itemKind = asHierarchyKind(itemKindValue);
    if (itemKind === undefined) failUnsupportedTarget(target);
    const hierarchyAdapter = LEGACY_IMPORT_TARGET_ADAPTERS[itemKind];
    let hierarchyIdentityValue: JsonRecord;
    try {
      hierarchyIdentityValue = { ...legacyImportTargetIdentity(hierarchyAdapter, target.key).identity };
    } catch {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
        `legacy import ${itemKind} target key is malformed`,
        { target_kind: itemKind },
      );
    }
    const milestoneId = itemKind === "milestone"
      ? hierarchyIdentityValue.id
      : hierarchyIdentityValue.milestone_id;
    const sliceId = itemKind === "milestone"
      ? null
      : hierarchyIdentityValue.slice_id ?? hierarchyIdentityValue.id;
    const taskId = itemKind === "task" ? hierarchyIdentityValue.id : null;
    const lifecycleIdentity = {
      project_id: base.authority.project_id,
      item_kind: itemKind,
      milestone_id: milestoneId,
      slice_id: sliceId,
      task_id: taskId,
    };
    if (candidate.normalized !== null && !Array.isArray(candidate.normalized) && typeof candidate.normalized === "object") {
      validateNormalizedIdentity(itemKind, hierarchyIdentityValue, candidate.normalized as JsonRecord, false);
    }
    return {
      address: {
        rowSet: "item_lifecycles",
        identity: canonicalLegacyImportJson(lifecycleIdentity),
        memberKey: target.key,
        field: "lifecycle_status",
        hierarchyAddress: rowAddress(
          hierarchyAdapter.rowSet,
          canonicalLegacyImportJson(hierarchyIdentityValue),
        ),
      },
      normalized: { lifecycle_status: normalizedStatusCandidate(candidate.normalized) },
    };
  }

  const adapter = targetAdapter(target);
  const normalized = target.field === undefined
    ? asRecord(candidate.normalized, `legacy import ${target.kind} candidate`)
    : {};
  let identityValue: JsonRecord;
  try {
    identityValue = { ...legacyImportTargetIdentity(adapter, target.key).identity };
  } catch {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
      `legacy import ${target.kind} target key is malformed`,
      { target_kind: target.kind },
    );
  }
  validateNormalizedIdentity(target.kind, identityValue, normalized, false);
  return {
    address: {
      rowSet: adapter.rowSet,
      identity: canonicalLegacyImportJson(identityValue),
      memberKey: target.key,
      ...(target.field === undefined ? {} : { field: adapter.aliases[target.field] ?? target.field }),
    },
    normalized,
  };
}

function normalizeStatus(value: LegacyImportValue): string {
  if (typeof value !== "string") {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
      "legacy import lifecycle status must be a string",
    );
  }
  const normalized = normalizeCanonicalLifecycleStatus(value) ?? normalizeLegacyLifecycleStatus(value);
  if (normalized === null) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
      "legacy import lifecycle status is unsupported",
      { status: value },
    );
  }
  return normalized;
}

function failUnsupportedTarget(target: LegacyImportTarget): never {
  fail(
    "LEGACY_IMPORT_CLASSIFICATION_TARGET_UNSUPPORTED",
    `unsupported legacy import comparison target ${target.kind}`,
    { target_kind: target.kind, target_key: target.key },
  );
}

function targetAdapter(target: LegacyImportTarget): LegacyImportTargetAdapter {
  const adapters = LEGACY_IMPORT_TARGET_ADAPTERS as Readonly<
    Partial<Record<string, LegacyImportTargetAdapter>>
  >;
  const adapter = adapters[target.kind];
  if (adapter === undefined) failUnsupportedTarget(target);
  return adapter;
}

function candidatePatch(
  prepared: ReturnType<typeof targetAddress>,
  candidate: LegacyImportInterpretationCandidate,
): JsonRecord {
  if (prepared.address.rowSet === "item_lifecycles") return prepared.normalized;
  const adapter = targetAdapter(candidate.target);
  const patch: JsonRecord = {};
  const entries = candidate.target.field === undefined
    ? Object.entries(prepared.normalized)
    : [[candidate.target.field, candidate.normalized] as const];
  for (const [inputField, value] of entries) {
    const field = adapter.aliases[inputField] ?? inputField;
    if (adapter.metadata.has(inputField)) continue;
    if (!adapter.fields.has(field)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
        `legacy import ${candidate.target.kind} field ${inputField} is not comparable`,
        { target_kind: candidate.target.kind, field: inputField },
      );
    }
    patch[field] = value;
  }
  if (Object.keys(patch).length === 0) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
      `legacy import ${candidate.target.kind} candidate has no comparable fields`,
      { target_kind: candidate.target.kind },
    );
  }
  return patch;
}

function prepareCandidate(
  base: LegacyImportBaseSnapshot,
  candidate: LegacyImportInterpretationCandidate,
): PreparedCandidate {
  const prepared = targetAddress(base, candidate);
  return { candidate, address: prepared.address, patch: candidatePatch(prepared, candidate) };
}

function targetKey(target: LegacyImportTarget): string {
  return canonicalLegacyImportJson(target);
}

function unresolvedTargets(
  resolutions: readonly LegacyImportPreviewResolution[],
): { fields: Set<string>; rows: Set<string>; wildcardRows: Set<string> } {
  const fields = new Set<string>();
  const rows = new Set<string>();
  const wildcardRows = new Set<string>();
  for (const resolution of resolutions) {
    if (
      resolution.target === undefined
      || (resolution.disposition !== "requires-user" && resolution.disposition !== "unsupported")
    ) continue;
    const row = targetKey({ kind: resolution.target.kind, key: resolution.target.key });
    rows.add(row);
    if (resolution.target.field === undefined) wildcardRows.add(row);
    else fields.add(targetKey(resolution.target));
  }
  return { fields, rows, wildcardRows };
}

function targetIsUnresolved(
  unresolved: ReturnType<typeof unresolvedTargets>,
  target: LegacyImportTarget,
): boolean {
  const row = targetKey({ kind: target.kind, key: target.key });
  return target.field === undefined
    ? unresolved.rows.has(row)
    : unresolved.wildcardRows.has(row) || unresolved.fields.has(targetKey(target));
}

function targetOrHierarchyIsUnresolved(
  unresolved: ReturnType<typeof unresolvedTargets>,
  target: LegacyImportTarget,
): boolean {
  if (targetIsUnresolved(unresolved, target)) return true;
  if (target.kind.endsWith("-status")) {
    return targetIsUnresolved(unresolved, {
      kind: target.kind.slice(0, -"-status".length),
      key: target.key,
    });
  }
  if (target.field === "status" && asHierarchyKind(target.kind) !== undefined) {
    return targetIsUnresolved(unresolved, { kind: `${target.kind}-status`, key: target.key });
  }
  return false;
}

function overlappingPatchFields(left: PreparedCandidate, right: PreparedCandidate): string[] {
  return Object.keys(left.patch).filter((field) => Object.hasOwn(right.patch, field));
}

function patchesConflict(left: PreparedCandidate, right: PreparedCandidate): boolean {
  return overlappingPatchFields(left, right).some((field) => (
    canonicalLegacyImportJson(left.patch[field]) !== canonicalLegacyImportJson(right.patch[field])
  ));
}

function ambiguityFromEvidence(
  evidence: readonly AmbiguityEvidence[],
  target: LegacyImportTarget,
  code: string,
  message: string,
): { diagnosis: LegacyImportPreviewDiagnosis; resolution: LegacyImportPreviewResolution } {
  const anchor = [...evidence].sort((left, right) => compareText(left.stableId, right.stableId))[0];
  const diagnosisValue = {
    code,
    severity: "blocker" as const,
    source_id: anchor.raw.source_id,
    locator: anchor.raw.locator,
    raw_value: anchor.raw.value,
    message,
  };
  const diagnosis = {
    diagnosis_id: hashLegacyImportValue({ ...diagnosisValue, target }),
    ...diagnosisValue,
  };
  return {
    diagnosis,
    resolution: { diagnosis_id: diagnosis.diagnosis_id, disposition: "requires-user", target },
  };
}

function ambiguityFor(
  claims: readonly PreparedCandidate[],
): { diagnosis: LegacyImportPreviewDiagnosis; resolution: LegacyImportPreviewResolution } {
  const ordered = [...claims].sort((left, right) => compareText(
    left.candidate.candidate_id,
    right.candidate.candidate_id,
  ));
  const anchor = ordered[0].candidate;
  const target = anchor.target.field === undefined
    ? anchor.target
    : { kind: anchor.target.kind, key: anchor.target.key };
  return ambiguityFromEvidence(
    ordered.map(({ candidate }) => ({ raw: candidate.raw, stableId: candidate.candidate_id })),
    target,
    "conflicting-legacy-import-target",
    "Multiple retained sources claim one authoritative import target; no route is selected automatically.",
  );
}

function valuesMatch(rowSet: LegacyImportBaseRowSet, current: JsonRecord, patch: JsonRecord): boolean {
  return Object.entries(patch).every(([field, value]) => (
    canonicalLegacyImportJson(normalizeStoredValue(rowSet, field, current[field] ?? null))
      === canonicalLegacyImportJson(value)
  ));
}

function requireLifecycleHierarchy(
  candidate: PreparedCandidate,
  rows: ReadonlyMap<string, JsonRecord>,
): JsonRecord {
  const hierarchy = candidate.address.hierarchyAddress === undefined
    ? undefined
    : rows.get(candidate.address.hierarchyAddress);
  if (hierarchy === undefined) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_LIFECYCLE_AUTHORITY_INVALID",
      "legacy import canonical lifecycle has no hierarchy row",
      { target_key: candidate.candidate.target.key },
    );
  }
  return hierarchy;
}

function lifecycleMatches(
  candidate: PreparedCandidate,
  current: JsonRecord,
  rows: ReadonlyMap<string, JsonRecord>,
): boolean {
  const desired = candidate.patch.lifecycle_status;
  const canonical = current.lifecycle_status;
  if (typeof desired !== "string" || typeof canonical !== "string") return false;
  const normalizedCanonical = normalizeCanonicalLifecycleStatus(canonical);
  if (normalizedCanonical === null) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_LIFECYCLE_AUTHORITY_INVALID",
      "legacy import canonical lifecycle status is invalid",
      { lifecycle_status: canonical },
    );
  }
  const hierarchy = requireLifecycleHierarchy(candidate, rows);
  const legacyStatus = typeof hierarchy.status === "string" ? hierarchy.status : null;
  const shadow = compareLifecycleShadow(legacyStatus, normalizedCanonical);
  return desired === normalizedCanonical
    && (shadow.kind === "match" || shadow.kind === "semantic_match_exact_delta");
}

function makeChange(
  action: "create" | "update" | "preserve",
  candidate: LegacyImportInterpretationCandidate,
  reasonCode: string,
): Omit<LegacyImportPreviewChange, "change_id"> {
  return {
    action,
    target: candidate.target,
    raw: candidate.raw,
    normalized: candidate.normalized,
    provenance: candidate.provenance,
    reason_code: reasonCode,
  };
}

function completeRawMembers(complete: LegacyImportCompleteRowSet): Map<string, LegacyImportValue> {
  if (!Array.isArray(complete.raw.value)) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      "legacy import complete row set raw collection must be an array",
    );
  }
  const members = new Map<string, LegacyImportValue>();
  for (const value of complete.raw.value) {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "legacy import complete row set raw collection contains a non-row member",
      );
    }
    const key = completeMemberKey(complete.row_set, value as JsonRecord);
    if (members.has(key)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "legacy import complete row set raw collection contains duplicate member keys",
        { member_key: key },
      );
    }
    members.set(key, value);
  }
  return members;
}

function validateCompleteSet(
  complete: LegacyImportCompleteRowSet,
  sources: ReadonlyMap<string, LegacyImportPreviewSource>,
): LegacyImportCompleteRowSet {
  const { complete_set_id: completeSetId, ...pending } = complete;
  if (hashLegacyImportValue(pending) !== completeSetId) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      "legacy import complete row set identity is inconsistent",
      { complete_set_id: completeSetId },
    );
  }
  if (LEGACY_IMPORT_COMPLETE_TARGET_KINDS[complete.row_set] !== complete.target_kind) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      `legacy import row set ${complete.row_set} cannot authorize ${complete.target_kind} deletes`,
      { row_set: complete.row_set, target_kind: complete.target_kind },
    );
  }
  validateProvenance(
    complete.provenance.source_id,
    complete.provenance.parser_id,
    complete.provenance.parser_version,
    sources,
  );
  if (complete.raw.source_id !== complete.provenance.source_id) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      "legacy import complete row set raw evidence and provenance disagree",
    );
  }
  const memberKeys = [...complete.member_keys].sort(compareText);
  if (new Set(memberKeys).size !== memberKeys.length || memberKeys.some((key) => key.length === 0)) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      "legacy import complete row set member keys are invalid",
    );
  }
  const rawMemberKeys = [...completeRawMembers(complete).keys()].sort(compareText);
  if (canonicalLegacyImportJson(rawMemberKeys) !== canonicalLegacyImportJson(memberKeys)) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      "legacy import complete row set member keys disagree with its raw collection",
    );
  }
  return { ...complete, member_keys: memberKeys };
}

function matchesCompleteSetSource(
  candidate: LegacyImportInterpretationCandidate,
  complete: LegacyImportCompleteRowSet,
): boolean {
  return candidate.raw.source_id === complete.raw.source_id
    && candidate.provenance.source_id === complete.provenance.source_id
    && candidate.provenance.parser_id === complete.provenance.parser_id
    && candidate.provenance.parser_version === complete.provenance.parser_version;
}

function validateCompleteMemberCandidates(
  complete: LegacyImportCompleteRowSet,
  candidates: readonly PreparedCandidate[],
): void {
  const rawMembers = completeRawMembers(complete);
  const memberKeys = new Set(complete.member_keys);
  for (const prepared of candidates) {
    const { address, candidate } = prepared;
    if (
      preparedAuthorityRow(prepared)
        === completeAuthorityRow(complete.row_set, address.memberKey)
      && matchesCompleteSetSource(candidate, complete)
      && !memberKeys.has(address.memberKey)
    ) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "legacy import complete row set omits a same-source candidate",
        { row_set: complete.row_set, member_key: address.memberKey },
      );
    }
  }
  for (const key of complete.member_keys) {
    const sameSourceClaims = candidates.filter((prepared) => (
      preparedAuthorityRow(prepared) === completeAuthorityRow(complete.row_set, key)
      && prepared.address.memberKey === key
      && matchesCompleteSetSource(prepared.candidate, complete)
    ));
    const claims = sameSourceClaims.filter(({ candidate }) => (
      candidate.target.kind === complete.target_kind && candidate.target.field === undefined
    ));
    if (claims.length !== 1) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "legacy import complete row set member candidate has no exactly-one same-source authoritative row candidate",
        { row_set: complete.row_set, member_key: key },
      );
    }
    validateNormalizedIdentity(
      complete.target_kind,
      asRecord(JSON.parse(claims[0].address.identity) as LegacyImportValue, "complete row identity"),
      asRecord(claims[0].candidate.normalized, "complete row candidate"),
      true,
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
    );
    const candidate = claims[0].candidate;
    const rawMember = rawMembers.get(key);
    if (rawMember === undefined) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "legacy import complete row set member keys disagree with its raw collection",
        { member_key: key },
      );
    }
    let candidateRawValue = candidate.raw.value;
    if (candidate.raw.locator.json_pointer === undefined && typeof candidateRawValue === "string") {
      try {
        candidateRawValue = JSON.parse(candidateRawValue) as LegacyImportValue;
      } catch {
        // Non-JSON string evidence compares as retained below.
      }
    }
    if (canonicalLegacyImportJson(candidateRawValue) !== canonicalLegacyImportJson(rawMember)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "legacy import complete row set member candidate contradicts the retained raw collection",
        { member_key: key },
      );
    }
    for (const fieldClaim of sameSourceClaims) {
      if (claims.includes(fieldClaim)) continue;
      if (fieldClaim.address.rowSet !== complete.row_set) continue;
      if (!valuesMatch(complete.row_set, claims[0].patch, fieldClaim.patch)) {
        fail(
          "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
          "legacy import complete row set has contradictory same-source row and field candidates",
          { row_set: complete.row_set, member_key: key },
        );
      }
    }
  }
}

function preparedCandidatesForRow(
  candidates: readonly PreparedCandidate[],
  rowSet: LegacyImportBaseRowSet,
  key: string,
): PreparedCandidate[] {
  return candidates.filter((candidate) => (
    preparedAuthorityRow(candidate) === completeAuthorityRow(rowSet, key)
  ));
}

function completeAuthorityRow(rowSet: LegacyImportBaseRowSet, member: string): string {
  return `${rowSet}\0${member}`;
}

function preparedAuthorityRow(candidate: PreparedCandidate): string {
  const targetKind = candidate.candidate.target.kind.endsWith("-status")
    ? candidate.candidate.target.kind.slice(0, -"-status".length)
    : candidate.candidate.target.kind;
  const adapter = targetAdapter({ ...candidate.candidate.target, kind: targetKind });
  return completeAuthorityRow(adapter.rowSet, candidate.address.memberKey);
}

function targetForBaseRow(rowSet: LegacyImportBaseRowSet, value: JsonRecord): LegacyImportTarget {
  const kind = LEGACY_IMPORT_COMPLETE_TARGET_KINDS[rowSet];
  if (kind === undefined) {
    fail("LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID", `legacy import ${rowSet} cannot be deleted`);
  }
  return { kind, key: memberKey(rowSet, value) };
}

function addFinalChange(
  changes: LegacyImportPreviewChange[],
  pending: Omit<LegacyImportPreviewChange, "change_id">,
  ids: Set<string>,
): void {
  const changeId = hashLegacyImportValue(pending);
  if (ids.has(changeId)) {
    fail(
      "LEGACY_IMPORT_CLASSIFICATION_CHANGE_ID_COLLISION",
      "legacy import classified changes have a duplicate identity",
      { change_id: changeId },
    );
  }
  ids.add(changeId);
  changes.push({ change_id: changeId, ...pending });
}

function derivedCounts(
  sources: readonly LegacyImportPreviewSource[],
  changes: readonly LegacyImportPreviewChange[],
  resolutions: readonly LegacyImportPreviewResolution[],
): LegacyImportPreviewCounts {
  return {
    create: changes.filter((change) => change.action === "create").length,
    update: changes.filter((change) => change.action === "update").length,
    delete: changes.filter((change) => change.action === "delete").length,
    preserve: changes.filter((change) => change.action === "preserve").length,
    unparsed: sources.filter((source) => source.outcome === "unparsed").length,
    unresolved: resolutions.filter((resolution) => (
      resolution.disposition === "requires-user" || resolution.disposition === "unsupported"
    )).length,
  };
}

export function classifyLegacyImportChanges(
  baseInput: LegacyImportBaseSnapshot,
  interpretationInput: LegacyImportInterpretation,
): LegacyImportClassification {
  const base = structuredClone(baseInput);
  const interpretation = structuredClone(interpretationInput);
  validateBase(base);
  const { ordered: sources, byId: sourcesById } = validateSources(interpretation.sources);
  interpretation.candidates.forEach((candidate) => validateCandidate(candidate, sourcesById));
  validateDiagnosisResolutionBijection(interpretation.diagnoses, interpretation.resolutions);

  const completeSets = interpretation.complete_row_sets.map((complete) => (
    validateCompleteSet(complete, sourcesById)
  ));
  const completeSetsByRowSet = new Map<LegacyImportBaseRowSet, LegacyImportCompleteRowSet[]>();
  for (const complete of completeSets) {
    const rowSets = completeSetsByRowSet.get(complete.row_set) ?? [];
    if (rowSets.some((existing) => existing.provenance.source_id === complete.provenance.source_id)) {
      fail(
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
        "one legacy import source contributed duplicate complete row sets",
        { row_set: complete.row_set, source_id: complete.provenance.source_id },
      );
    }
    rowSets.push(complete);
    completeSetsByRowSet.set(complete.row_set, rowSets);
  }

  const rows = buildBaseRows(base);
  const originalRows = new Map([...rows].map(([key, row]) => [key, { ...row }]));
  const preserves = interpretation.candidates.filter((candidate) => candidate.classification === "preserve");
  const prepared = interpretation.candidates
    .filter((candidate) => candidate.classification === "compare")
    .map((candidate) => prepareCandidate(base, candidate));
  for (const complete of completeSets) {
    validateCompleteMemberCandidates(complete, prepared);
  }

  const diagnoses = [...interpretation.diagnoses];
  const resolutions = [...interpretation.resolutions];
  const excludedTargets = unresolvedTargets(resolutions);
  const excludedRows = new Set<string>();

  for (const [rowSet, rowSets] of completeSetsByRowSet) {
    const memberKeys = new Set(rowSets.flatMap((complete) => complete.member_keys));
    for (const candidate of prepared) {
      if (
        preparedAuthorityRow(candidate)
          === completeAuthorityRow(rowSet, candidate.address.memberKey)
      ) {
        memberKeys.add(candidate.address.memberKey);
      }
    }
    for (const [addressKey, row] of originalRows) {
      if (!addressKey.startsWith(`${rowSet}\0`)) continue;
      const key = memberKey(rowSet, row);
      memberKeys.add(key);
    }
    for (const key of memberKeys) {
      const rowCandidates = preparedCandidatesForRow(prepared, rowSet, key);
      const otherSourceClaims = rowCandidates.filter((candidate) => (
        !matchesCompleteSetSource(candidate.candidate, rowSets[0])
      ));
      const retainedByCompleteSet = rowSets[0].member_keys.includes(key);
      const authoritativeCandidate = rowCandidates.find((candidate) => (
        candidate.address.field === undefined
        && matchesCompleteSetSource(candidate.candidate, rowSets[0])
      ));
      const hasCompletenessConflict = rowSets.length > 1
        || (!retainedByCompleteSet && otherSourceClaims.length > 0)
        || (authoritativeCandidate !== undefined && otherSourceClaims.some((candidate) => (
          patchesConflict(authoritativeCandidate, candidate)
        )));
      if (!hasCompletenessConflict) continue;

      excludedRows.add(completeAuthorityRow(rowSet, key));
      const target = { kind: rowSets[0].target_kind, key };
      const evidence: AmbiguityEvidence[] = [
        ...rowSets.map((complete) => ({
          raw: complete.preview_raw ?? complete.raw,
          stableId: complete.complete_set_id,
        })),
        ...rowCandidates.map(({ candidate }) => ({
          raw: candidate.raw,
          stableId: candidate.candidate_id,
        })),
      ];
      if (!targetIsUnresolved(excludedTargets, target)) {
        const ambiguity = ambiguityFromEvidence(
          evidence,
          target,
          "conflicting-legacy-import-completeness",
          "Multiple retained sources claim completeness for one authoritative row; no route is selected automatically.",
        );
        diagnoses.push(ambiguity.diagnosis);
        resolutions.push(ambiguity.resolution);
      }
    }
  }

  const claims = new Map<string, PreparedCandidate[]>();
  for (const candidate of prepared) {
    const row = preparedAuthorityRow(candidate);
    claims.set(row, [...(claims.get(row) ?? []), candidate]);
  }
  for (const [row, grouped] of claims) {
    let hasCrossSourceConflict = false;
    for (let leftIndex = 0; leftIndex < grouped.length; leftIndex += 1) {
      const left = grouped[leftIndex];
      for (const right of grouped.slice(leftIndex + 1)) {
        const fields = overlappingPatchFields(left, right);
        if (fields.length === 0) continue;
        if (left.candidate.provenance.source_id !== right.candidate.provenance.source_id) {
          if (patchesConflict(left, right)) hasCrossSourceConflict = true;
          continue;
        }
        if (patchesConflict(left, right)) {
          fail(
            "LEGACY_IMPORT_CLASSIFICATION_CANDIDATE_INCONSISTENT",
            "legacy import source has contradictory row and field candidates",
            { source_id: left.candidate.provenance.source_id },
          );
        }
      }
    }
    if (!hasCrossSourceConflict || excludedRows.has(row)) continue;
    excludedRows.add(row);
    const ambiguity = ambiguityFor(grouped);
    diagnoses.push(ambiguity.diagnosis);
    resolutions.push(ambiguity.resolution);
  }

  const pendingChanges: Array<Omit<LegacyImportPreviewChange, "change_id">> = [];
  const orderedCandidates = [...prepared].sort((left, right) => {
    const fieldOrder = Number(left.address.field !== undefined) - Number(right.address.field !== undefined);
    const patchBreadth = Object.keys(right.patch).length - Object.keys(left.patch).length;
    return fieldOrder || patchBreadth || compareText(
      canonicalLegacyImportJson([left.candidate.target, left.candidate.candidate_id]),
      canonicalLegacyImportJson([right.candidate.target, right.candidate.candidate_id]),
    );
  });
  for (const preparedCandidate of orderedCandidates) {
    const { candidate, address, patch } = preparedCandidate;
    if (
      excludedRows.has(preparedAuthorityRow(preparedCandidate))
      || targetOrHierarchyIsUnresolved(excludedTargets, candidate.target)
    ) {
      continue;
    }
    const key = rowAddress(address.rowSet, address.identity);
    const current = rows.get(key);
    const complete = completeSetsByRowSet.get(address.rowSet)?.[0];
    const completeMember = complete?.member_keys.includes(address.memberKey) === true;
    if (current === undefined) {
      if (address.rowSet === "item_lifecycles") {
        requireLifecycleHierarchy(preparedCandidate, rows);
      }
      pendingChanges.push(makeChange(
        "create",
        candidate,
        completeMember ? "candidate-row-absent-from-base" : candidate.reason_code,
      ));
      rows.set(key, { ...patch });
      continue;
    }
    const equal = address.rowSet === "item_lifecycles"
      ? lifecycleMatches(preparedCandidate, current, rows)
      : valuesMatch(address.rowSet, current, patch);
    Object.assign(current, patch);
    if (!equal) {
      pendingChanges.push(makeChange(
        "update",
        candidate,
        completeMember ? "candidate-row-differs-from-base" : candidate.reason_code,
      ));
    }
  }

  for (const complete of completeSets) {
    if ((completeSetsByRowSet.get(complete.row_set)?.length ?? 0) > 1) continue;
    const members = new Set(complete.member_keys);
    for (const [addressKey, row] of originalRows) {
      if (!addressKey.startsWith(`${complete.row_set}\0`)) continue;
      const key = memberKey(complete.row_set, row);
      if (members.has(key)) continue;
      const target = targetForBaseRow(complete.row_set, row);
      if (
        excludedRows.has(completeAuthorityRow(complete.row_set, key))
        || targetIsUnresolved(excludedTargets, target)
      ) continue;
      pendingChanges.push({
        action: "delete",
        target,
        raw: complete.preview_raw ?? complete.raw,
        normalized: null,
        provenance: complete.provenance,
        reason_code: "complete-snapshot-row-absent",
      });
    }
  }
  for (const candidate of preserves) {
    pendingChanges.push(makeChange("preserve", candidate, candidate.reason_code));
  }

  const changes: LegacyImportPreviewChange[] = [];
  const changeIds = new Set<string>();
  for (const pending of pendingChanges) addFinalChange(changes, pending, changeIds);
  changes.sort((left, right) => compareText(left.change_id, right.change_id));
  diagnoses.sort((left, right) => compareText(left.diagnosis_id, right.diagnosis_id));
  resolutions.sort((left, right) => compareText(left.diagnosis_id, right.diagnosis_id));
  validateDiagnosisResolutionBijection(diagnoses, resolutions);
  const counts = derivedCounts(sources, changes, resolutions);
  return deepFreeze({
    applicable: counts.unresolved === 0,
    sources,
    changes,
    diagnoses,
    resolutions,
    counts,
    source_set_hash: hashLegacyImportValue(sources),
    change_set_hash: hashLegacyImportValue(changes),
  });
}
