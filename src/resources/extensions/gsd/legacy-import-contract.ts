// Project/App: gsd-pi
// File Purpose: Exact workflow_import_applications.preview_json wire contract for legacy import.

export const LEGACY_IMPORT_CHANGE_ACTIONS = [
  "create",
  "update",
  "delete",
  "preserve",
] as const;

export const LEGACY_IMPORT_SOURCE_OUTCOMES = [
  "mapped",
  "preserved",
  "unparsed",
  "ignored-with-reason",
] as const;

export const LEGACY_IMPORT_RESOLUTION_DISPOSITIONS = [
  "mapped",
  "preserved",
  "requires-user",
  "unsupported",
] as const;

export const LEGACY_IMPORT_PREVIEW_TOP_LEVEL_KEYS = [
  "preview_schema_version",
  "preview_id",
  "import_kind",
  "importer_version",
  "base_project_revision",
  "base_authority_epoch",
  "base_database_schema_version",
  "source_set_hash",
  "change_set_hash",
  "counts",
  "sources",
  "changes",
  "diagnoses",
  "resolutions",
] as const;

export const LEGACY_IMPORT_PREVIEW_COUNT_KEYS = [
  "create",
  "update",
  "delete",
  "preserve",
  "unparsed",
  "unresolved",
] as const;

export const LEGACY_IMPORT_SOURCE_ENTRY_KEYS = [
  "source_id",
  "path",
  "kind",
  "byte_size",
  "sha256",
  "parser_id",
  "parser_version",
  "encoding",
  "outcome",
] as const;

export const LEGACY_IMPORT_CHANGE_ENTRY_KEYS = [
  "change_id",
  "action",
  "target",
  "raw",
  "normalized",
  "provenance",
  "reason_code",
] as const;

export const LEGACY_IMPORT_DIAGNOSIS_ENTRY_KEYS = [
  "diagnosis_id",
  "code",
  "severity",
  "source_id",
  "locator",
  "raw_value",
  "message",
] as const;

export const LEGACY_IMPORT_RESOLUTION_ENTRY_KEYS = [
  "diagnosis_id",
  "disposition",
  "target",
] as const;

export const LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION = 1 as const;
export const LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION = 49 as const;

export type LegacyImportChangeAction = (typeof LEGACY_IMPORT_CHANGE_ACTIONS)[number];
export type LegacyImportSourceOutcome = (typeof LEGACY_IMPORT_SOURCE_OUTCOMES)[number];
export type LegacyImportResolutionDisposition =
  (typeof LEGACY_IMPORT_RESOLUTION_DISPOSITIONS)[number];
export type LegacyImportSha256 = `sha256:${string}`;

export type LegacyImportValue =
  | null
  | boolean
  | number
  | string
  | readonly LegacyImportValue[]
  | { readonly [key: string]: LegacyImportValue };

export interface LegacyImportLocator {
  start_byte: number;
  end_byte?: number;
  line?: number;
  json_pointer?: string;
}

export interface LegacyImportTarget {
  kind: string;
  key: string;
  field?: string;
}

export interface LegacyImportRawValue {
  source_id: string;
  locator: LegacyImportLocator;
  value: LegacyImportValue;
  sha256: LegacyImportSha256;
}

export interface LegacyImportProvenance {
  source_id: string;
  parser_id: string;
  parser_version: string;
}

export interface LegacyImportPreviewSource {
  source_id: string;
  path: string;
  kind: string;
  byte_size: number;
  sha256: LegacyImportSha256;
  parser_id: string;
  parser_version: string;
  encoding: "utf-8" | "binary";
  outcome: LegacyImportSourceOutcome;
}

export interface LegacyImportPreviewChange {
  change_id: string;
  action: LegacyImportChangeAction;
  target: LegacyImportTarget;
  raw: LegacyImportRawValue;
  normalized: LegacyImportValue;
  provenance: LegacyImportProvenance;
  reason_code: string;
}

export interface LegacyImportPreviewDiagnosis {
  diagnosis_id: string;
  code: string;
  severity: "info" | "warning" | "blocker";
  source_id: string;
  locator: LegacyImportLocator;
  raw_value: LegacyImportValue;
  message: string;
}

export interface LegacyImportPreviewResolution {
  diagnosis_id: string;
  disposition: LegacyImportResolutionDisposition;
  target?: LegacyImportTarget;
}

export interface LegacyImportPreviewCounts {
  create: number;
  update: number;
  delete: number;
  preserve: number;
  unparsed: number;
  unresolved: number;
}

/** Exact JSON object sealed by workflow_import_applications.preview_json. */
export interface LegacyImportPreviewEnvelope {
  preview_schema_version: typeof LEGACY_IMPORT_PREVIEW_SCHEMA_VERSION;
  preview_id: string;
  import_kind: string;
  importer_version: string;
  base_project_revision: number;
  base_authority_epoch: number;
  base_database_schema_version: typeof LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
  source_set_hash: LegacyImportSha256;
  change_set_hash: LegacyImportSha256;
  counts: LegacyImportPreviewCounts;
  sources: readonly LegacyImportPreviewSource[];
  changes: readonly LegacyImportPreviewChange[];
  diagnoses: readonly LegacyImportPreviewDiagnosis[];
  resolutions: readonly LegacyImportPreviewResolution[];
}
