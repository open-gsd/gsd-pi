// Project/App: gsd-pi
// File Purpose: Public read-only creation, revalidation, identity, and sealing boundary for legacy import Preview artifacts.

import { compareText, deepFreeze } from "./legacy-import-utils.js";

import { createHash } from "node:crypto";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  LEGACY_IMPORT_CHANGE_ACTIONS,
  LEGACY_IMPORT_CHANGE_ENTRY_KEYS,
  LEGACY_IMPORT_DIAGNOSIS_ENTRY_KEYS,
  LEGACY_IMPORT_PREVIEW_COUNT_KEYS,
  LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS,
  LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
  LEGACY_IMPORT_RESOLUTION_DISPOSITIONS,
  LEGACY_IMPORT_SOURCE_ENTRY_KEYS,
  LEGACY_IMPORT_SOURCE_OUTCOMES,
  type LegacyImportPreviewChange,
  type LegacyImportPreviewCounts,
  type LegacyImportPreviewDiagnosis,
  type LegacyImportPreviewEnvelope,
  type LegacyImportPreviewResolution,
  type LegacyImportPreviewSource,
  type LegacyImportSha256,
  type LegacyImportValue,
} from "./legacy-import-contract.js";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import { classifyLegacyImportChanges } from "./legacy-import-preview-classifier.js";
import { composeLegacyImportInterpretation } from "./legacy-import-preview-composition.js";
import {
  collectLegacyImportDatabaseTargetEvidence,
} from "./legacy-import-preview-database-target.js";
import {
  inspectLegacyImportDatabaseTarget,
  inspectLegacyImportGsdDatabaseEvidence,
} from "./legacy-import-database-target-inspector.js";
import type { LegacyImportGsdDatabaseEvidence } from "./legacy-import-preview-gsd.js";
import {
  captureLegacyImportSourceSet,
  revalidateLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
} from "./legacy-import-preview-source.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const LEGACY_IMPORT_PREVIEW_IMPORT_KIND = "legacy-markdown";
export const LEGACY_IMPORT_PREVIEW_IMPORTER_VERSION = "1";

export interface LegacyImportPreviewArtifact {
  preview: LegacyImportPreviewEnvelope;
  preview_hash: LegacyImportSha256;
}

export interface LegacyImportPreviewSealInput {
  import_kind: string;
  importer_version: string;
  base: LegacyImportBaseSnapshot;
  source_set_hash: LegacyImportSha256;
  change_set_hash: LegacyImportSha256;
  counts: LegacyImportPreviewCounts;
  sources: readonly LegacyImportPreviewSource[];
  changes: readonly LegacyImportPreviewChange[];
  diagnoses: readonly LegacyImportPreviewDiagnosis[];
  resolutions: readonly LegacyImportPreviewResolution[];
}

export interface LegacyImportPreviewCreateInput {
  roots: readonly LegacyImportSourceRoot[];
  bundledDefinitionNames?: readonly string[];
}

export type LegacyImportPreviewErrorCode =
  | "LEGACY_IMPORT_PREVIEW_BASE_CHANGED"
  | "LEGACY_IMPORT_PREVIEW_EXPECTED_INVALID"
  | "LEGACY_IMPORT_PREVIEW_RESOLUTION_INVALID"
  | "LEGACY_IMPORT_PREVIEW_CHANGED";

export class LegacyImportPreviewError extends Error {
  readonly stage: "create" | "resolve" | "revalidate";
  readonly code: LegacyImportPreviewErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, LegacyImportValue>>;

  constructor(
    stage: "create" | "resolve" | "revalidate",
    code: LegacyImportPreviewErrorCode,
    message: string,
    retryable: boolean,
    context: Readonly<Record<string, LegacyImportValue>> = {},
  ) {
    super(message);
    this.name = "LegacyImportPreviewError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
    this.context = Object.freeze({ ...context });
  }
}

export interface LegacyImportPreviewTestHooks {
  afterSourceCapture?(capture: LegacyImportSourceCapture): void;
  afterBaseCapture?(base: LegacyImportBaseSnapshot): void;
  afterClassification?(): void;
  afterSourceRevalidation?(): void;
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("legacy import identity requires strict JSON with finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("legacy import identity requires acyclic strict JSON");
    const keys = Object.keys(value);
    if (
      keys.length !== value.length
      || keys.some((key, index) => key !== String(index))
      || Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error("legacy import identity requires dense JSON arrays without extra keys");
    }
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new Error("legacy import identity requires strict JSON values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("legacy import identity requires plain JSON objects");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("legacy import identity requires strict JSON without symbol keys");
  }
  if (ancestors.has(value)) throw new Error("legacy import identity requires acyclic strict JSON");
  ancestors.add(value);
  try {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalLegacyImportJson(value: unknown): string {
  return canonicalJson(value, new Set());
}

export function hashLegacyImportBytes(value: string | Uint8Array): LegacyImportSha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashLegacyImportValue(value: unknown): LegacyImportSha256 {
  return hashLegacyImportBytes(canonicalLegacyImportJson(value));
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
}

function requireCanonicalKind(value: string): void {
  requireNonBlank(value, "import_kind");
  if (value !== value.trim().toLowerCase()) {
    throw new Error("import_kind must be trimmed lowercase text");
  }
}

function requireHash(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${field} must be a canonical SHA-256`);
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateCounts(input: LegacyImportPreviewSealInput): void {
  for (const [name, value] of Object.entries(input.counts)) {
    requireNonNegativeSafeInteger(value, `counts.${name}`);
  }
  const expected = {
    create: input.changes.filter((change) => change.action === "create").length,
    update: input.changes.filter((change) => change.action === "update").length,
    delete: input.changes.filter((change) => change.action === "delete").length,
    preserve: input.changes.filter((change) => change.action === "preserve").length,
    unparsed: input.sources.filter((source) => source.outcome === "unparsed").length,
    unresolved: input.resolutions.filter(
      (resolution) => resolution.disposition === "requires-user" || resolution.disposition === "unsupported",
    ).length,
  };
  if (canonicalLegacyImportJson(input.counts) !== canonicalLegacyImportJson(expected)) {
    throw new Error("legacy import Preview counts do not match evidence");
  }
}

function validateSealInput(input: LegacyImportPreviewSealInput): void {
  requireCanonicalKind(input.import_kind);
  requireNonBlank(input.importer_version, "importer_version");
  requireHash(input.source_set_hash, "source_set_hash");
  requireHash(input.change_set_hash, "change_set_hash");
  requireHash(input.base.relevant_rows_hash, "base.relevant_rows_hash");
  if (input.base.snapshot_schema_version !== 1) {
    throw new Error("legacy import base snapshot schema 1 is required");
  }
  if (input.base.database_schema_version !== LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION) {
    throw new Error(`legacy import database schema ${LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION} is required`);
  }
  requireNonBlank(input.base.authority.project_id, "base.authority.project_id");
  requireNonNegativeSafeInteger(input.base.authority.revision, "base.authority.revision");
  requireNonNegativeSafeInteger(input.base.authority.authority_epoch, "base.authority.authority_epoch");
  if (hashLegacyImportValue(input.base.rows) !== input.base.relevant_rows_hash) {
    throw new Error("base.relevant_rows_hash does not match base rows");
  }
  if (hashLegacyImportValue(input.sources) !== input.source_set_hash) {
    throw new Error("source_set_hash does not match Preview sources");
  }
  if (hashLegacyImportValue(input.changes) !== input.change_set_hash) {
    throw new Error("change_set_hash does not match Preview changes");
  }
  validateCounts(input);
}

export function isStrictLegacyImportData(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1) return false;
      if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, "length") ?? {}, "value")) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined
          || !Object.hasOwn(descriptor, "value")
          || descriptor.enumerable !== true
          || !isStrictLegacyImportData(descriptor.value, ancestors)
        ) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (
        !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || !isStrictLegacyImportData(descriptor.value, ancestors)
      ) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Derive a non-circular approval identity, then hash the complete exact v1
 * envelope. The base row hash catches relevant DB drift even if a broken
 * external writer failed to advance the authority revision.
 */
export function sealLegacyImportPreview(input: LegacyImportPreviewSealInput): LegacyImportPreviewArtifact {
  const sealedInput = structuredClone(input);
  validateSealInput(sealedInput);
  const previewId = hashLegacyImportValue({
    preview_schema_version: LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
    import_kind: sealedInput.import_kind,
    importer_version: sealedInput.importer_version,
    project_id: sealedInput.base.authority.project_id,
    project_root_realpath: sealedInput.base.authority.project_root_realpath,
    base_project_revision: sealedInput.base.authority.revision,
    base_authority_epoch: sealedInput.base.authority.authority_epoch,
    base_database_schema_version: sealedInput.base.database_schema_version,
    base_snapshot_schema_version: sealedInput.base.snapshot_schema_version,
    relevant_rows_hash: sealedInput.base.relevant_rows_hash,
    source_set_hash: sealedInput.source_set_hash,
    change_set_hash: sealedInput.change_set_hash,
  });
  const preview: LegacyImportPreviewEnvelope = {
    preview_schema_version: LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION,
    preview_id: previewId,
    import_kind: sealedInput.import_kind,
    importer_version: sealedInput.importer_version,
    base_project_revision: sealedInput.base.authority.revision,
    base_authority_epoch: sealedInput.base.authority.authority_epoch,
    base_database_schema_version: sealedInput.base.database_schema_version,
    source_set_hash: sealedInput.source_set_hash,
    change_set_hash: sealedInput.change_set_hash,
    counts: sealedInput.counts,
    sources: sealedInput.sources,
    changes: sealedInput.changes,
    diagnoses: sealedInput.diagnoses,
    resolutions: sealedInput.resolutions,
  };
  const previewHash = hashLegacyImportValue(preview);
  return deepFreeze({ preview, preview_hash: previewHash });
}

function approvalBase(base: LegacyImportBaseSnapshot): Readonly<Record<string, LegacyImportValue>> {
  return {
    snapshot_schema_version: base.snapshot_schema_version,
    database_schema_version: base.database_schema_version,
    project_id: base.authority.project_id,
    project_root_realpath: base.authority.project_root_realpath,
    revision: base.authority.revision,
    authority_epoch: base.authority.authority_epoch,
    relevant_rows_hash: base.relevant_rows_hash,
  };
}

function createLegacyImportPreviewInternal(
  input: LegacyImportPreviewCreateInput,
  hooks: LegacyImportPreviewTestHooks,
): LegacyImportPreviewArtifact {
  const capture = captureLegacyImportSourceSet({ roots: input.roots });
  hooks.afterSourceCapture?.(capture);
  const base = captureCurrentLegacyImportBaseSnapshot();
  hooks.afterBaseCapture?.(base);
  const gsdDatabaseEvidence: LegacyImportGsdDatabaseEvidence[] = [];
  const databaseTargetEvidence = collectLegacyImportDatabaseTargetEvidence(capture, (request) => {
    const evidence = inspectLegacyImportDatabaseTarget(request);
    if (
      request.logical_path.toLowerCase() === ".gsd/gsd.db"
      && evidence.inspection.kind === "sqlite"
      && evidence.inspection.schema.version_table_kind === "table"
      && evidence.inspection.schema.version_row_count === 1
      && evidence.inspection.schema.invalid_version_count === 0
      && evidence.inspection.schema.versions.length === 1
      && evidence.inspection.schema.versions[0] === LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION
      && evidence.inspection.schema.anchors.project_authority
      && evidence.inspection.schema.anchors.workflow_import_applications
      && evidence.inspection.schema.anchors.milestone_reopen_trigger
      && evidence.inspection.schema.anchors.authority_recovery_receipts
    ) {
      gsdDatabaseEvidence.push(inspectLegacyImportGsdDatabaseEvidence(request));
    }
    return evidence;
  });
  const interpretation = composeLegacyImportInterpretation(capture, {
    databaseTargetEvidence,
    gsdDatabaseEvidence,
    ...(input.bundledDefinitionNames === undefined
      ? {}
      : { bundledDefinitionNames: input.bundledDefinitionNames }),
  });
  const classification = classifyLegacyImportChanges(base, interpretation);
  hooks.afterClassification?.();
  revalidateLegacyImportSourceSet(capture);
  hooks.afterSourceRevalidation?.();
  const confirmedBase = captureCurrentLegacyImportBaseSnapshot();
  const expectedBase = approvalBase(base);
  const observedBase = approvalBase(confirmedBase);
  if (canonicalLegacyImportJson(expectedBase) !== canonicalLegacyImportJson(observedBase)) {
    throw new LegacyImportPreviewError(
      "create",
      "LEGACY_IMPORT_PREVIEW_BASE_CHANGED",
      "legacy import Preview base changed during creation",
      true,
      {
        expected_base_hash: hashLegacyImportValue(expectedBase),
        observed_base_hash: hashLegacyImportValue(observedBase),
        expected_revision: base.authority.revision,
        observed_revision: confirmedBase.authority.revision,
        expected_authority_epoch: base.authority.authority_epoch,
        observed_authority_epoch: confirmedBase.authority.authority_epoch,
      },
    );
  }
  return sealLegacyImportPreview({
    import_kind: LEGACY_IMPORT_PREVIEW_IMPORT_KIND,
    importer_version: LEGACY_IMPORT_PREVIEW_IMPORTER_VERSION,
    base,
    source_set_hash: classification.source_set_hash,
    change_set_hash: classification.change_set_hash,
    counts: classification.counts,
    sources: classification.sources,
    changes: classification.changes,
    diagnoses: classification.diagnoses,
    resolutions: classification.resolutions,
  });
}

export function createLegacyImportPreview(
  input: LegacyImportPreviewCreateInput,
): LegacyImportPreviewArtifact {
  return createLegacyImportPreviewInternal(input, {});
}

/** Test-only timing hooks for public-boundary race sabotage. */
export function _createLegacyImportPreviewForTest(
  input: LegacyImportPreviewCreateInput,
  hooks: LegacyImportPreviewTestHooks,
): LegacyImportPreviewArtifact {
  return createLegacyImportPreviewInternal(input, hooks);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    return false;
  }
  return required.every((key) => Object.hasOwn(value, key));
}

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalHash(value: unknown): value is LegacyImportSha256 {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validTarget(value: unknown): boolean {
  return hasExactKeys(value, ["kind", "key"], ["field"])
    && isNonblank(value["kind"])
    && isNonblank(value["key"])
    && (value["field"] === undefined || isNonblank(value["field"]));
}

function validLocator(value: unknown): boolean {
  if (!hasExactKeys(value, ["start_byte"], ["end_byte", "line", "json_pointer"])) return false;
  if (!isNonNegativeSafeInteger(value["start_byte"])) return false;
  // Zero-length spans are valid evidence for empty files and empty string tokens;
  // inverted spans remain invalid.
  if (
    value["end_byte"] !== undefined
    && (!isNonNegativeSafeInteger(value["end_byte"]) || value["end_byte"] < value["start_byte"])
  ) return false;
  if (value["line"] !== undefined && (!isNonNegativeSafeInteger(value["line"]) || value["line"] < 1)) {
    return false;
  }
  return value["json_pointer"] === undefined || typeof value["json_pointer"] === "string";
}

function canonicalIds(values: readonly Record<string, unknown>[], field: string): boolean {
  const ids = values.map((value) => value[field]);
  return ids.every(isCanonicalHash) && new Set(ids).size === ids.length;
}

function canonicallyOrderedIds(values: readonly Record<string, unknown>[], field: string): boolean {
  return canonicalIds(values, field)
    && values.every((value, index) => (
      index === 0 || compareText(values[index - 1]?.[field] as string, value[field] as string) < 0
    ));
}

function validateExpectedPreviewStructure(expected: unknown): expected is LegacyImportPreviewArtifact {
  if (!hasExactKeys(expected, ["preview", "preview_hash"]) || !isCanonicalHash(expected["preview_hash"])) {
    return false;
  }
  const preview = expected["preview"];
  if (
    !hasExactKeys(preview, LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS)
    || preview["preview_schema_version"] !== LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION
    || !isCanonicalHash(preview["preview_id"])
    || preview["import_kind"] !== LEGACY_IMPORT_PREVIEW_IMPORT_KIND
    || preview["importer_version"] !== LEGACY_IMPORT_PREVIEW_IMPORTER_VERSION
    || !isNonNegativeSafeInteger(preview["base_project_revision"])
    || !isNonNegativeSafeInteger(preview["base_authority_epoch"])
    || preview["base_database_schema_version"] !== LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION
    || !isCanonicalHash(preview["source_set_hash"])
    || !isCanonicalHash(preview["change_set_hash"])
    || !hasExactKeys(preview["counts"], LEGACY_IMPORT_PREVIEW_COUNT_KEYS)
    || !Array.isArray(preview["sources"])
    || !Array.isArray(preview["changes"])
    || !Array.isArray(preview["diagnoses"])
    || !Array.isArray(preview["resolutions"])
  ) return false;

  const counts = preview["counts"];
  if (!Object.values(counts).every(isNonNegativeSafeInteger)) return false;
  const sources = preview["sources"];
  if (!sources.every((source): source is Record<string, unknown> => (
    hasExactKeys(source, LEGACY_IMPORT_SOURCE_ENTRY_KEYS)
    && isCanonicalHash(source["source_id"])
    && isNonblank(source["path"])
    && isNonblank(source["kind"])
    && isNonNegativeSafeInteger(source["byte_size"])
    && isCanonicalHash(source["sha256"])
    && isNonblank(source["parser_id"])
    && isNonblank(source["parser_version"])
    && (source["encoding"] === "utf-8" || source["encoding"] === "binary")
    && LEGACY_IMPORT_SOURCE_OUTCOMES.includes(source["outcome"] as never)
  )) || !canonicalIds(sources, "source_id")) return false;
  if (
    new Set(sources.map((source) => source["path"])).size !== sources.length
    || sources.some((source, index) => index > 0 && (
      compareText(sources[index - 1]?.["path"] as string, source["path"] as string)
      || compareText(sources[index - 1]?.["source_id"] as string, source["source_id"] as string)
    ) > 0)
  ) return false;
  const sourceIds = new Set(sources.map((source) => source["source_id"]));

  const changes = preview["changes"];
  if (!changes.every((change): change is Record<string, unknown> => {
    if (
      !hasExactKeys(change, LEGACY_IMPORT_CHANGE_ENTRY_KEYS)
      || !isCanonicalHash(change["change_id"])
      || !LEGACY_IMPORT_CHANGE_ACTIONS.includes(change["action"] as never)
      || !validTarget(change["target"])
      || !hasExactKeys(change["raw"], ["source_id", "locator", "value", "sha256"])
      || !hasExactKeys(change["provenance"], ["source_id", "parser_id", "parser_version"])
      || !isNonblank(change["reason_code"])
    ) return false;
    const raw = change["raw"];
    const provenance = change["provenance"];
    if (
      !isCanonicalHash(raw["source_id"])
      || !sourceIds.has(raw["source_id"])
      || !validLocator(raw["locator"])
      || !isCanonicalHash(raw["sha256"])
      || provenance["source_id"] !== raw["source_id"]
      || !isNonblank(provenance["parser_id"])
      || !isNonblank(provenance["parser_version"])
    ) return false;
    canonicalLegacyImportJson(raw["value"]);
    canonicalLegacyImportJson(change["normalized"]);
    return true;
  }) || !canonicallyOrderedIds(changes, "change_id")) return false;

  const diagnoses = preview["diagnoses"];
  if (!diagnoses.every((diagnosis): diagnosis is Record<string, unknown> => {
    if (
      !hasExactKeys(diagnosis, LEGACY_IMPORT_DIAGNOSIS_ENTRY_KEYS)
      || !isCanonicalHash(diagnosis["diagnosis_id"])
      || !isNonblank(diagnosis["code"])
      || !(["info", "warning", "blocker"] as const).includes(diagnosis["severity"] as never)
      || !isCanonicalHash(diagnosis["source_id"])
      || !sourceIds.has(diagnosis["source_id"])
      || !validLocator(diagnosis["locator"])
      || !isNonblank(diagnosis["message"])
    ) return false;
    canonicalLegacyImportJson(diagnosis["raw_value"]);
    return true;
  }) || !canonicallyOrderedIds(diagnoses, "diagnosis_id")) return false;

  const resolutions = preview["resolutions"];
  if (!resolutions.every((resolution): resolution is Record<string, unknown> => (
    hasExactKeys(resolution, ["diagnosis_id", "disposition"], ["target"])
    && isCanonicalHash(resolution["diagnosis_id"])
    && LEGACY_IMPORT_RESOLUTION_DISPOSITIONS.includes(resolution["disposition"] as never)
    && (resolution["target"] === undefined || validTarget(resolution["target"]))
  )) || !canonicallyOrderedIds(resolutions, "diagnosis_id")) return false;
  if (
    resolutions.length !== diagnoses.length
    || resolutions.some((resolution, index) => resolution["diagnosis_id"] !== diagnoses[index]?.["diagnosis_id"])
  ) return false;

  const derivedCounts = {
    create: changes.filter((change) => change["action"] === "create").length,
    update: changes.filter((change) => change["action"] === "update").length,
    delete: changes.filter((change) => change["action"] === "delete").length,
    preserve: changes.filter((change) => change["action"] === "preserve").length,
    unparsed: sources.filter((source) => source["outcome"] === "unparsed").length,
    unresolved: resolutions.filter((resolution) => (
      resolution["disposition"] === "requires-user" || resolution["disposition"] === "unsupported"
    )).length,
  };
  return LEGACY_IMPORT_PREVIEW_COUNT_KEYS.every((key) => counts[key] === derivedCounts[key])
    && hashLegacyImportValue(sources) === preview["source_set_hash"]
    && hashLegacyImportValue(changes) === preview["change_set_hash"]
    && hashLegacyImportValue(preview) === expected["preview_hash"];
}

export function isValidLegacyImportPreviewArtifact(
  expected: unknown,
): expected is LegacyImportPreviewArtifact {
  try {
    return validateExpectedPreviewStructure(expected);
  } catch {
    return false;
  }
}

function validateExpectedPreview(expected: unknown): asserts expected is LegacyImportPreviewArtifact {
  if (isValidLegacyImportPreviewArtifact(expected)) return;
  throw new LegacyImportPreviewError(
    "revalidate",
    "LEGACY_IMPORT_PREVIEW_EXPECTED_INVALID",
    "legacy import Preview revalidation received an invalid expected artifact",
    false,
  );
}

export interface LegacyImportPreviewResolutionChoice {
  diagnosis_id: string;
  disposition: "preserved";
}

/** Record reviewed choices on an immutable sealed Preview and seal the result. */
export function resolveLegacyImportPreview(
  expected: LegacyImportPreviewArtifact,
  choices: readonly LegacyImportPreviewResolutionChoice[],
): LegacyImportPreviewArtifact {
  let artifact: LegacyImportPreviewArtifact;
  let selected: readonly LegacyImportPreviewResolutionChoice[];
  try {
    artifact = structuredClone(expected);
    selected = structuredClone(choices);
  } catch {
    throw new LegacyImportPreviewError(
      "resolve",
      "LEGACY_IMPORT_PREVIEW_RESOLUTION_INVALID",
      "legacy import Preview resolutions could not be detached",
      false,
    );
  }
  if (!isValidLegacyImportPreviewArtifact(artifact) || !Array.isArray(selected)) {
    throw new LegacyImportPreviewError(
      "resolve",
      "LEGACY_IMPORT_PREVIEW_RESOLUTION_INVALID",
      "legacy import Preview resolutions require a valid sealed Preview",
      false,
    );
  }

  const byDiagnosis = new Map(artifact.preview.resolutions.map((resolution) => (
    [resolution.diagnosis_id, resolution] as const
  )));
  const updates = new Map<string, LegacyImportPreviewResolution>();
  for (const choice of selected) {
    if (
      !hasExactKeys(choice, ["diagnosis_id", "disposition"])
      || !isCanonicalHash(choice.diagnosis_id)
      || choice.disposition !== "preserved"
      || updates.has(choice.diagnosis_id)
    ) {
      throw new LegacyImportPreviewError(
        "resolve",
        "LEGACY_IMPORT_PREVIEW_RESOLUTION_INVALID",
        "legacy import Preview contains an invalid or duplicate resolution choice",
        false,
      );
    }
    const current = byDiagnosis.get(choice.diagnosis_id);
    if (current?.disposition !== "requires-user") {
      throw new LegacyImportPreviewError(
        "resolve",
        "LEGACY_IMPORT_PREVIEW_RESOLUTION_INVALID",
        "legacy import Preview resolution choice does not identify a user-required diagnosis",
        false,
      );
    }
    updates.set(choice.diagnosis_id, {
      diagnosis_id: choice.diagnosis_id,
      disposition: choice.disposition,
      ...(current.target === undefined ? {} : { target: current.target }),
    });
  }

  const resolutions = artifact.preview.resolutions.map((resolution) => (
    updates.get(resolution.diagnosis_id) ?? resolution
  ));
  const preview: LegacyImportPreviewEnvelope = {
    ...artifact.preview,
    counts: {
      ...artifact.preview.counts,
      unresolved: resolutions.filter((resolution) => (
        resolution.disposition === "requires-user" || resolution.disposition === "unsupported"
      )).length,
    },
    resolutions,
  };
  return deepFreeze({ preview, preview_hash: hashLegacyImportValue(preview) });
}

export function revalidateLegacyImportPreview(
  input: LegacyImportPreviewCreateInput,
  expected: LegacyImportPreviewArtifact,
): LegacyImportPreviewArtifact {
  validateExpectedPreview(expected);
  const created = createLegacyImportPreview(input);
  const createdResolutions = new Map(created.preview.resolutions.map((resolution) => (
    [resolution.diagnosis_id, resolution] as const
  )));
  const choices = expected.preview.resolutions.flatMap((resolution) => {
    const createdResolution = createdResolutions.get(resolution.diagnosis_id);
    return createdResolution?.disposition === "requires-user"
      && resolution.disposition === "preserved"
      ? [{ diagnosis_id: resolution.diagnosis_id, disposition: "preserved" as const }]
      : [];
  });
  const observed = choices.length === 0
    ? created
    : resolveLegacyImportPreview(created, choices);
  if (observed.preview_hash !== expected.preview_hash) {
    throw new LegacyImportPreviewError(
      "revalidate",
      "LEGACY_IMPORT_PREVIEW_CHANGED",
      "legacy import Preview changed during revalidation",
      true,
      {
        expected_preview_hash: expected.preview_hash,
        observed_preview_hash: observed.preview_hash,
      },
    );
  }
  return observed;
}
