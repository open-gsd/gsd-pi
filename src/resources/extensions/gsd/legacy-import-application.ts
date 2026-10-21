// Project/App: gsd-pi
// File Purpose: Public v1 contract for explicit transactional legacy Import Application.

import type { ExecutionInvocation } from "./execution-invocation.js";
import { deepFreeze } from "./legacy-import-utils.js";
import {
  LegacyImportBackupError,
  isValidLegacyImportVerifiedBackup,
  validateLegacyImportVerifiedBackup,
  verifyLegacyImportBackupArtifact,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import {
  LegacyImportApplicationError,
} from "./legacy-import-application-error.js";
import type { LegacyImportSha256 } from "./legacy-import-contract.js";
import {
  LegacyImportPreviewError,
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  isStrictLegacyImportData,
  isValidLegacyImportPreviewArtifact,
  revalidateLegacyImportPreview,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
} from "./legacy-import-preview.js";
import {
  LegacyImportBaseSnapshotError,
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import {
  LegacyImportSourceError,
  validateLegacyImportSourceRoots,
  type LegacyImportSourceRoot,
} from "./legacy-import-preview-source.js";
import {
  compileLegacyImportApplicationPlan,
  legacyImportProjectionKind,
  type LegacyImportApplicationPlan,
} from "./legacy-import-application-plan.js";
import {
  canonicalDomainJson,
  executeImportDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
  type ImportDomainOperationRequest,
} from "./db/domain-operation.js";
import { getDb, readTransaction } from "./db/engine.js";
import {
  applyLegacyImportApplicationPlan,
  insertLegacyImportApplicationReceipt,
  type LegacyImportApplicationInstructionResult,
} from "./db/writers/legacy-import-application.js";
import {
  GSD_IDEMPOTENCY_CONFLICT,
  GSD_REVISION_CONFLICT,
  GSDError,
} from "./errors.js";

export {
  LegacyImportApplicationError,
  type LegacyImportApplicationErrorCode,
  type LegacyImportApplicationErrorStage,
} from "./legacy-import-application-error.js";

export const LEGACY_IMPORT_APPLICATION_OPERATION_TYPE = "import.apply" as const;
export const LEGACY_IMPORT_APPLICATION_EVENT_TYPE = "legacy-import.applied" as const;
export const LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION = 1 as const;
export const LEGACY_IMPORT_APPLICATION_CONSENT_SCHEMA_VERSION = 1 as const;

export type LegacyImportApplicationBoundaryPoint =
  | "after-coordination"
  | "after-final-validation"
  | "after-plan"
  | "after-receipt";

type LegacyImportApplicationBoundaryHook = (
  point: LegacyImportApplicationBoundaryPoint,
) => void;

let applicationBoundaryHookForTest: LegacyImportApplicationBoundaryHook | null = null;

export function _setLegacyImportApplicationBoundaryForTest(
  hook: LegacyImportApplicationBoundaryHook | null,
): void {
  applicationBoundaryHookForTest = hook;
}

function reachApplicationBoundary(point: LegacyImportApplicationBoundaryPoint): void {
  applicationBoundaryHookForTest?.(point);
}

export interface LegacyImportApplicationInput {
  readonly invocation: Readonly<ExecutionInvocation>;
  readonly previewInput: Readonly<LegacyImportPreviewCreateInput>;
  readonly preview: Readonly<LegacyImportPreviewArtifact>;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
  readonly destructiveConsent?: Readonly<LegacyImportApplicationConsent>;
}

export interface LegacyImportApplicationConsent {
  readonly consentSchemaVersion: typeof LEGACY_IMPORT_APPLICATION_CONSENT_SCHEMA_VERSION;
  readonly decision: "proceed";
  readonly previewHash: LegacyImportSha256;
  readonly changeSetHash: LegacyImportSha256;
  readonly deleteCount: number;
}

export interface LegacyImportApplicationInvocationIdentity {
  readonly idempotencyKey: string;
  readonly sourceTransport: ExecutionInvocation["sourceTransport"];
  readonly actorType: string;
  readonly actorId: string | null;
  readonly traceId: string | null;
  readonly turnId: string | null;
}

export interface LegacyImportApplicationReplayIdentity {
  readonly replayIdentitySchemaVersion:
    typeof LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION;
  readonly invocation: Readonly<LegacyImportApplicationInvocationIdentity>;
  readonly previewInputHash: LegacyImportSha256;
  readonly previewId: string;
  readonly previewHash: LegacyImportSha256;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
}

export interface LegacyImportApplicationIdentity {
  readonly replayIdentity: Readonly<LegacyImportApplicationReplayIdentity>;
  readonly applicationIdentityHash: LegacyImportSha256;
}

export interface LegacyImportApplicationReceipt {
  readonly status: "committed" | "replayed";
  readonly operationId: string;
  readonly projectId: string;
  readonly applicationIdentityHash: LegacyImportSha256;
  readonly previewId: string;
  readonly previewHash: LegacyImportSha256;
  readonly backupId: LegacyImportSha256;
  readonly baseProjectRevision: number;
  readonly baseAuthorityEpoch: number;
  readonly resultingRevision: number;
  readonly resultingAuthorityEpoch: number;
  readonly appliedAt: string;
  readonly eventIds: readonly string[];
  readonly outboxIds: readonly number[];
  readonly projectionWorkIds: readonly string[];
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
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => (
      (required.includes(key) || optional.includes(key))
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ));
}

function failContract(message: string): never {
  throw new LegacyImportApplicationError(
    "contract",
    "LEGACY_IMPORT_APPLICATION_CONTRACT_INVALID",
    message,
    false,
  );
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failContract(`${field} must be non-blank text`);
  }
  return value;
}

function normalizeInvocation(value: unknown): LegacyImportApplicationInvocationIdentity {
  if (!hasExactKeys(
    value,
    ["idempotencyKey", "sourceTransport", "actorType"],
    ["actorId", "traceId", "turnId"],
  )) {
    failContract("legacy import Application invocation does not satisfy the exact v1 contract");
  }
  const invocation = value;
  const sourceTransport = invocation["sourceTransport"];
  if (!(sourceTransport === "internal" || sourceTransport === "pi-tool" || sourceTransport === "workflow-mcp")) {
    failContract("legacy import Application source transport is invalid");
  }
  function optionalIdentity(field: "actorId" | "traceId" | "turnId"): string | null {
    const candidate = invocation[field];
    return candidate === undefined ? null : requireNonBlank(candidate, `invocation.${field}`);
  }
  return {
    idempotencyKey: requireNonBlank(invocation["idempotencyKey"], "invocation.idempotencyKey"),
    sourceTransport,
    actorType: requireNonBlank(invocation["actorType"], "invocation.actorType"),
    actorId: optionalIdentity("actorId"),
    traceId: optionalIdentity("traceId"),
    turnId: optionalIdentity("turnId"),
  };
}

function normalizeBundledDefinitionNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!hasExactArrayDataProperties(value)) {
    failContract("previewInput.bundledDefinitionNames must be an array");
  }
  const names = Array.from(value, (entry, index) => (
    requireNonBlank(entry, `previewInput.bundledDefinitionNames[${index}]`)
  ));
  return [...new Set(names)].sort();
}

function hasExactArrayDataProperties(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return false;
  if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, "length") ?? {}, "value")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(index)) ?? {}, "value")) {
      return false;
    }
  }
  return true;
}

function normalizePreviewInput(value: unknown): {
  roots: LegacyImportSourceRoot[];
  bundledDefinitionNames: string[];
} {
  if (!hasExactKeys(value, ["roots"], ["bundledDefinitionNames"])) {
    failContract("legacy import Preview input does not satisfy the exact v1 contract");
  }
  let roots: LegacyImportSourceRoot[];
  try {
    roots = validateLegacyImportSourceRoots(value["roots"]);
  } catch {
    failContract("legacy import Preview roots do not satisfy the exact v1 contract");
  }
  return {
    roots,
    bundledDefinitionNames: normalizeBundledDefinitionNames(value["bundledDefinitionNames"]),
  };
}

function requireBackupLinkage(
  value: unknown,
  preview: LegacyImportPreviewArtifact,
): asserts value is LegacyImportVerifiedBackup {
  if (!isValidLegacyImportVerifiedBackup(value)) {
    failContract("verified backup does not satisfy the complete self-identical v1 contract");
  }
  if (
    value["preview_id"] !== preview.preview.preview_id
    || value["preview_hash"] !== preview.preview_hash
  ) {
    failContract("verified backup does not match the sealed Preview identity");
  }
}

interface LegacyImportApplicationSnapshot {
  readonly input: LegacyImportApplicationInput;
  readonly identity: LegacyImportApplicationIdentity;
}

function normalizeDestructiveConsent(value: unknown): LegacyImportApplicationConsent | undefined {
  if (value === undefined) return undefined;
  if (!hasExactKeys(value, [
    "consentSchemaVersion",
    "decision",
    "previewHash",
    "changeSetHash",
    "deleteCount",
  ])) {
    failContract("legacy import destructive consent does not satisfy the exact v1 contract");
  }
  if (
    value["consentSchemaVersion"] !== LEGACY_IMPORT_APPLICATION_CONSENT_SCHEMA_VERSION
    || value["decision"] !== "proceed"
    || typeof value["previewHash"] !== "string"
    || typeof value["changeSetHash"] !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(value["previewHash"])
    || !/^sha256:[0-9a-f]{64}$/u.test(value["changeSetHash"])
    || !Number.isSafeInteger(value["deleteCount"])
    || Number(value["deleteCount"]) < 1
  ) {
    failContract("legacy import destructive consent is invalid");
  }
  return {
    consentSchemaVersion: LEGACY_IMPORT_APPLICATION_CONSENT_SCHEMA_VERSION,
    decision: "proceed",
    previewHash: value["previewHash"] as LegacyImportSha256,
    changeSetHash: value["changeSetHash"] as LegacyImportSha256,
    deleteCount: Number(value["deleteCount"]),
  };
}

export function createLegacyImportApplicationConsent(
  preview: Readonly<LegacyImportPreviewArtifact>,
): LegacyImportApplicationConsent {
  if (!isValidLegacyImportPreviewArtifact(preview) || preview.preview.counts.delete < 1) {
    failContract("legacy import destructive consent requires a sealed Preview with deletes");
  }
  return deepFreeze({
    consentSchemaVersion: LEGACY_IMPORT_APPLICATION_CONSENT_SCHEMA_VERSION,
    decision: "proceed",
    previewHash: preview.preview_hash,
    changeSetHash: preview.preview.change_set_hash,
    deleteCount: preview.preview.counts.delete,
  });
}

function requireDestructiveConsent(snapshot: LegacyImportApplicationSnapshot): void {
  const preview = snapshot.input.preview;
  if (preview.preview.counts.delete === 0) return;
  const consent = snapshot.input.destructiveConsent;
  if (
    consent?.previewHash === preview.preview_hash
    && consent.changeSetHash === preview.preview.change_set_hash
    && consent.deleteCount === preview.preview.counts.delete
  ) return;
  throw new LegacyImportApplicationError(
    "preview",
    "LEGACY_IMPORT_APPLICATION_DESTRUCTIVE_CONSENT_REQUIRED",
    "legacy import deletes require consent bound to the sealed Preview",
    false,
    {
      preview_hash: preview.preview_hash,
      change_set_hash: preview.preview.change_set_hash,
      delete_count: preview.preview.counts.delete,
    },
  );
}

function snapshotLegacyImportApplication(value: unknown): LegacyImportApplicationSnapshot {
  if (!hasExactKeys(value, ["invocation", "previewInput", "preview", "backup"], ["destructiveConsent"])) {
    failContract("legacy import Application input does not satisfy the exact v1 contract");
  }
  if (!isStrictLegacyImportData(value)) {
    failContract("legacy import Application input must contain acyclic strict data properties");
  }
  let detached: Record<string, unknown>;
  try {
    detached = structuredClone(value);
  } catch {
    failContract("legacy import Application input must be detached strict data");
  }
  if (!isValidLegacyImportPreviewArtifact(detached["preview"])) {
    failContract("legacy import Application Preview does not satisfy the sealed v1 contract");
  }
  const preview = detached["preview"];
  const normalizedPreviewInput = normalizePreviewInput(detached["previewInput"]);
  requireBackupLinkage(detached["backup"], preview);
  const invocation = normalizeInvocation(detached["invocation"]);
  const destructiveConsent = normalizeDestructiveConsent(detached["destructiveConsent"]);
  const replayIdentity: LegacyImportApplicationReplayIdentity = {
    replayIdentitySchemaVersion: LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION,
    invocation,
    previewInputHash: hashLegacyImportValue(normalizedPreviewInput),
    previewId: preview.preview.preview_id,
    previewHash: preview.preview_hash,
    backup: detached["backup"],
  };
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: invocation.idempotencyKey,
      sourceTransport: invocation.sourceTransport,
      actorType: invocation.actorType,
      ...(invocation.actorId === null ? {} : { actorId: invocation.actorId }),
      ...(invocation.traceId === null ? {} : { traceId: invocation.traceId }),
      ...(invocation.turnId === null ? {} : { turnId: invocation.turnId }),
    },
    previewInput: normalizedPreviewInput,
    preview,
    backup: detached["backup"],
    ...(destructiveConsent === undefined ? {} : { destructiveConsent }),
  };
  return deepFreeze({
    input,
    identity: {
      replayIdentity,
      applicationIdentityHash: hashLegacyImportValue(replayIdentity),
    },
  });
}

export function createLegacyImportApplicationIdentity(
  value: unknown,
): LegacyImportApplicationIdentity {
  return snapshotLegacyImportApplication(value).identity;
}

type DbRow = Record<string, unknown>;

interface ReplayAggregate {
  readonly operation: DbRow;
  readonly application: DbRow;
  readonly events: readonly DbRow[];
  readonly outbox: readonly DbRow[];
  readonly projections: readonly DbRow[];
}

function replayConflict(message: string): never {
  throw new LegacyImportApplicationError(
    "replay",
    "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT",
    message,
    false,
  );
}

function receiptInconsistent(message: string): never {
  throw new LegacyImportApplicationError(
    "receipt",
    "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    message,
    false,
  );
}

function loadReplayAggregate(
  snapshot: LegacyImportApplicationSnapshot,
): ReplayAggregate | null {
  return readTransaction(() => {
    const db = getDb();
    const project = db.prepare(
      "SELECT project_id FROM project_authority WHERE singleton = 1",
    ).get() as DbRow | undefined;
    if (!project || typeof project["project_id"] !== "string") {
      throw mapBaseFailure(new LegacyImportBaseSnapshotError(
        "LEGACY_IMPORT_BASE_AUTHORITY_MISSING",
        "legacy import project authority is missing",
      ));
    }
    const projectId = project["project_id"];
    const byKey = db.prepare(`SELECT operation_id FROM workflow_operations
      WHERE project_id = :project_id AND idempotency_key = :idempotency_key`).get({
      ":project_id": projectId,
      ":idempotency_key": snapshot.identity.replayIdentity.invocation.idempotencyKey,
    }) as DbRow | undefined;
    const byPreview = db.prepare(`SELECT operation_id FROM workflow_import_applications
      WHERE project_id = :project_id AND (preview_id = :preview_id OR preview_hash = :preview_hash)
      ORDER BY operation_id`).all({
      ":project_id": projectId,
      ":preview_id": snapshot.identity.replayIdentity.previewId,
      ":preview_hash": snapshot.identity.replayIdentity.previewHash,
    }) as DbRow[];
    const operationIds = new Set<string>();
    if (typeof byKey?.["operation_id"] === "string") operationIds.add(byKey["operation_id"]);
    for (const row of byPreview) {
      if (typeof row["operation_id"] !== "string") receiptInconsistent("legacy import receipt identity is invalid");
      operationIds.add(row["operation_id"]);
    }
    if (operationIds.size === 0) return null;
    if (operationIds.size !== 1) replayConflict("legacy import key and Preview identities resolve to different Applications");
    const operationId = [...operationIds][0]!;
    if (byKey === undefined) {
      replayConflict("legacy import durable identity does not match the requested key and Preview");
    }
    const operation = db.prepare(
      "SELECT * FROM workflow_operations WHERE operation_id = :operation_id",
    ).get({ ":operation_id": operationId }) as DbRow | undefined;
    if (!operation) receiptInconsistent("legacy import durable operation is missing");
    const events = db.prepare(`SELECT * FROM workflow_domain_events
      WHERE operation_id = :operation_id ORDER BY event_index`).all({ ":operation_id": operationId }) as DbRow[];
    if (byPreview.length !== 1 || byPreview[0]?.["operation_id"] !== operationId) {
      if (operation["operation_type"] !== LEGACY_IMPORT_APPLICATION_OPERATION_TYPE) {
        replayConflict("legacy import key belongs to different committed work");
      }
      const payloadJson = events[0]?.["payload_json"];
      let storedIdentity: unknown;
      try {
        storedIdentity = (JSON.parse(String(payloadJson)) as DbRow)["applicationIdentityHash"];
      } catch {
        receiptInconsistent("legacy import durable Application event is invalid");
      }
      if (storedIdentity !== snapshot.identity.applicationIdentityHash) {
        replayConflict("legacy import replay identity differs from the committed Application");
      }
      receiptInconsistent("legacy import durable Application receipt is missing");
    }
    const application = db.prepare(
      "SELECT * FROM workflow_import_applications WHERE operation_id = :operation_id",
    ).get({ ":operation_id": operationId }) as DbRow | undefined;
    if (!application) receiptInconsistent("legacy import durable Application receipt is missing");
    const outbox = db.prepare(`SELECT outbox.outbox_id, outbox.event_id, outbox.destination
      FROM workflow_outbox outbox
      JOIN workflow_domain_events event ON event.event_id = outbox.event_id
      WHERE event.operation_id = :operation_id
      ORDER BY outbox.outbox_id`).all({ ":operation_id": operationId }) as DbRow[];
    const projections = db.prepare(`SELECT
        current.projection_work_id, current.project_id, current.projection_key,
        current.projection_kind, current.supersedes_projection_work_id,
        current.renderer_version, current.source_project_revision,
        current.source_authority_epoch, current.enqueue_operation_id, current.created_at,
        previous.projection_work_id AS predecessor_id,
        previous.project_id AS predecessor_project_id,
        previous.projection_key AS predecessor_key,
        previous.projection_kind AS predecessor_kind,
        previous.source_project_revision AS predecessor_revision,
        previous.source_authority_epoch AS predecessor_epoch
      FROM workflow_projection_work current
      LEFT JOIN workflow_projection_work previous
        ON previous.projection_work_id = current.supersedes_projection_work_id
      WHERE current.enqueue_operation_id = :operation_id
      ORDER BY current.projection_work_id`).all({ ":operation_id": operationId }) as DbRow[];
    return { operation, application, events, outbox, projections };
  });
}

function applicationEventPayload(
  snapshot: LegacyImportApplicationSnapshot,
  plan: LegacyImportApplicationPlan,
  applicationRelevantRowsHash: LegacyImportSha256,
  instructionResults: readonly LegacyImportApplicationInstructionResult[],
): DomainJsonValue {
  return {
    replayIdentitySchemaVersion: LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION,
    applicationIdentityHash: snapshot.identity.applicationIdentityHash,
    previewInputHash: snapshot.identity.replayIdentity.previewInputHash,
    backupArtifactHash: hashLegacyImportValue(snapshot.input.backup),
    backupId: snapshot.input.backup.backup_id,
    applicationRelevantRowsHash,
    planSchemaVersion: plan.planSchemaVersion,
    eventFacts: plan.eventFacts as unknown as DomainJsonValue,
    projectionKeys: [...plan.projectionKeys],
    instructionResults: instructionResults.map((result) => ({
      action: result.action,
      targetKind: result.targetKind,
      targetIdentityHash: result.targetIdentityHash,
      expectedAffectedRows: result.expectedAffectedRows,
      affectedRows: result.affectedRows,
    })),
  };
}

const INSTRUCTION_RESULT_ACTIONS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
  "create-decision-memory",
  "update-decision-memory",
  "delete-decision-memory",
  "replace-slice-dependencies",
  "delete-slice-dependencies",
  "adopt-lifecycle",
  "seed-quality-gate",
  "preserve",
]);

function isStoredInstructionResult(value: unknown): value is LegacyImportApplicationInstructionResult {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort().join("\0");
  if (keys !== ["action", "affectedRows", "expectedAffectedRows", "targetIdentityHash", "targetKind"].sort().join("\0")) {
    return false;
  }
  return typeof value["action"] === "string"
    && INSTRUCTION_RESULT_ACTIONS.has(value["action"])
    && typeof value["targetKind"] === "string"
    && typeof value["targetIdentityHash"] === "string"
    && /^sha256:[0-9a-f]{64}$/.test(value["targetIdentityHash"])
    && Number.isSafeInteger(value["expectedAffectedRows"])
    && (value["expectedAffectedRows"] as number) >= 0
    && Number.isSafeInteger(value["affectedRows"])
    && (value["affectedRows"] as number) >= 0;
}

function storedApplicationInstructionResults(
  payloadJson: unknown,
): readonly LegacyImportApplicationInstructionResult[] {
  try {
    const value = (JSON.parse(String(payloadJson)) as DbRow)["instructionResults"];
    if (Array.isArray(value) && value.every(isStoredInstructionResult)) return value;
  } catch {
    // Normalized below.
  }
  return receiptInconsistent("legacy import Application instruction results are invalid");
}

function storedApplicationRelevantRowsHash(payloadJson: unknown): LegacyImportSha256 {
  try {
    const value = (JSON.parse(String(payloadJson)) as DbRow)["applicationRelevantRowsHash"];
    if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)) {
      return value as LegacyImportSha256;
    }
  } catch {
    // Normalized below.
  }
  return receiptInconsistent("legacy import Application result rows hash is invalid");
}

function storedValueMatches(row: DbRow, field: string, expected: unknown): boolean {
  return Object.hasOwn(row, field) && row[field] === expected;
}

function requireReplayInputMatch(
  aggregate: ReplayAggregate,
  snapshot: LegacyImportApplicationSnapshot,
): void {
  const invocation = snapshot.identity.replayIdentity.invocation;
  const preview = snapshot.input.preview.preview;
  const backup = snapshot.input.backup;
  const payloadJson = aggregate.events[0]?.["payload_json"];
  let storedIdentity: unknown;
  try {
    const payload = JSON.parse(String(payloadJson)) as Record<string, unknown>;
    storedIdentity = payload["applicationIdentityHash"];
  } catch {
    receiptInconsistent("legacy import Application event payload is invalid");
  }
  if (storedIdentity !== snapshot.identity.applicationIdentityHash) {
    replayConflict("legacy import replay identity differs from the committed Application");
  }
  const operationMatches = [
    ["operation_type", LEGACY_IMPORT_APPLICATION_OPERATION_TYPE],
    ["idempotency_key", invocation.idempotencyKey],
    ["expected_revision", preview.base_project_revision],
    ["resulting_revision", preview.base_project_revision + 1],
    ["expected_authority_epoch", preview.base_authority_epoch],
    ["resulting_authority_epoch", preview.base_authority_epoch],
    ["actor_type", invocation.actorType],
    ["actor_id", invocation.actorId],
    ["source_transport", invocation.sourceTransport],
    ["trace_id", invocation.traceId],
    ["turn_id", invocation.turnId],
    ["request_hash", snapshot.input.preview.preview_hash],
  ].every(([field, expected]) => storedValueMatches(aggregate.operation, String(field), expected));
  const applicationMatches = [
    ["operation_id", aggregate.operation["operation_id"]],
    ["project_id", aggregate.operation["project_id"]],
    ["import_kind", preview.import_kind],
    ["importer_version", preview.importer_version],
    ["preview_schema_version", preview.preview_schema_version],
    ["preview_id", preview.preview_id],
    ["preview_hash", snapshot.input.preview.preview_hash],
    ["base_project_revision", preview.base_project_revision],
    ["base_authority_epoch", preview.base_authority_epoch],
    ["base_database_schema_version", preview.base_database_schema_version],
    ["source_set_hash", preview.source_set_hash],
    ["change_set_hash", preview.change_set_hash],
    ["create_count", preview.counts.create],
    ["update_count", preview.counts.update],
    ["delete_count", preview.counts.delete],
    ["preserve_count", preview.counts.preserve],
    ["unparsed_count", preview.counts.unparsed],
    ["unresolved_count", preview.counts.unresolved],
    ["preview_json", canonicalLegacyImportJson(preview)],
    ["backup_ref", backup.backup_ref],
    ["backup_sha256", backup.backup_sha256],
    ["backup_byte_size", backup.backup_byte_size],
    ["backup_schema_version", backup.backup_database_schema_version],
    ["backup_project_revision", backup.base_project_revision],
    ["backup_authority_epoch", backup.base_authority_epoch],
    ["backup_quick_check", backup.quick_check],
    ["backup_verified_at", backup.verified_at],
    ["resulting_project_revision", preview.base_project_revision + 1],
    ["resulting_authority_epoch", preview.base_authority_epoch],
  ].every(([field, expected]) => storedValueMatches(aggregate.application, String(field), expected));
  if (!operationMatches || !applicationMatches) {
    receiptInconsistent("legacy import committed Application facts are inconsistent");
  }
  if (
    aggregate.operation["created_at"] !== aggregate.application["applied_at"]
    || aggregate.operation["created_at"] !== aggregate.events[0]?.["created_at"]
    || typeof aggregate.application["applied_at"] !== "string"
  ) receiptInconsistent("legacy import Application timestamps are inconsistent");
}

function requireReplayAggregate(
  aggregate: ReplayAggregate,
  snapshot: LegacyImportApplicationSnapshot,
  plan: LegacyImportApplicationPlan,
): void {
  requireReplayInputMatch(aggregate, snapshot);
  const operationId = String(aggregate.operation["operation_id"]);
  const projectId = String(aggregate.operation["project_id"]);
  const resultingRevision = Number(aggregate.operation["resulting_revision"]);
  const resultingEpoch = Number(aggregate.operation["resulting_authority_epoch"]);
  const previewId = snapshot.input.preview.preview.preview_id;
  const event = aggregate.events[0];
  const expectedPayload = canonicalDomainJson(applicationEventPayload(
    snapshot,
    plan,
    storedApplicationRelevantRowsHash(event?.["payload_json"]),
    storedApplicationInstructionResults(event?.["payload_json"]),
  ));
  if (
    aggregate.events.length !== 1
    || !event
    || event["operation_id"] !== operationId
    || event["event_index"] !== 0
    || event["project_id"] !== projectId
    || event["project_revision"] !== resultingRevision
    || event["authority_epoch"] !== resultingEpoch
    || event["event_type"] !== LEGACY_IMPORT_APPLICATION_EVENT_TYPE
    || event["entity_type"] !== "legacy-import"
    || event["entity_id"] !== previewId
    || event["caused_by_event_id"] !== null
    || event["payload_json"] !== expectedPayload
  ) receiptInconsistent("legacy import Application event is inconsistent");
  if (
    aggregate.outbox.length !== 1
    || aggregate.outbox[0]?.["event_id"] !== event["event_id"]
    || aggregate.outbox[0]?.["destination"] !== "projection"
  ) receiptInconsistent("legacy import Application outbox identity is inconsistent");
  if (aggregate.projections.length !== plan.projectionKeys.length) {
    receiptInconsistent("legacy import Application projection count is inconsistent");
  }
  plan.projectionKeys.forEach((projectionKey, index) => {
    const projection = aggregate.projections[index];
    const projectionKind = legacyImportProjectionKind(projectionKey);
    const predecessorId = projection?.["supersedes_projection_work_id"];
    let predecessorMatches = predecessorId === null && projection?.["predecessor_id"] === null;
    if (typeof predecessorId === "string") {
      predecessorMatches = projection?.["predecessor_id"] === predecessorId
        && projection?.["predecessor_project_id"] === projectId
        && projection?.["predecessor_key"] === projectionKey
        && projection?.["predecessor_kind"] === projectionKind
        && Number(projection?.["predecessor_revision"]) < resultingRevision
        && Number(projection?.["predecessor_epoch"]) <= resultingEpoch;
    }
    if (
      !projection
      || projection["projection_work_id"] !== `${operationId}:${String(index).padStart(4, "0")}`
      || projection["project_id"] !== projectId
      || projection["projection_key"] !== projectionKey
      || projection["projection_kind"] !== projectionKind
      || projection["renderer_version"] !== "v1"
      || projection["source_project_revision"] !== resultingRevision
      || projection["source_authority_epoch"] !== resultingEpoch
      || projection["enqueue_operation_id"] !== operationId
      || projection["created_at"] !== aggregate.operation["created_at"]
      || !predecessorMatches
    ) receiptInconsistent("legacy import Application projection identity is inconsistent");
  });
}

function receiptFromAggregate(
  aggregate: ReplayAggregate,
  snapshot: LegacyImportApplicationSnapshot,
  status: LegacyImportApplicationReceipt["status"],
): LegacyImportApplicationReceipt {
  const outboxIds = aggregate.outbox.map((row) => Number(row["outbox_id"]));
  if (outboxIds.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    receiptInconsistent("legacy import Application outbox identity is invalid");
  }
  return deepFreeze({
    status,
    operationId: String(aggregate.operation["operation_id"]),
    projectId: String(aggregate.operation["project_id"]),
    applicationIdentityHash: snapshot.identity.applicationIdentityHash,
    previewId: snapshot.input.preview.preview.preview_id,
    previewHash: snapshot.input.preview.preview_hash,
    backupId: snapshot.input.backup.backup_id,
    baseProjectRevision: Number(aggregate.operation["expected_revision"]),
    baseAuthorityEpoch: Number(aggregate.operation["expected_authority_epoch"]),
    resultingRevision: Number(aggregate.operation["resulting_revision"]),
    resultingAuthorityEpoch: Number(aggregate.operation["resulting_authority_epoch"]),
    appliedAt: String(aggregate.application["applied_at"]),
    eventIds: aggregate.events.map((row) => String(row["event_id"])),
    outboxIds,
    projectionWorkIds: aggregate.projections.map((row) => String(row["projection_work_id"])),
  });
}

function replayReceipt(
  snapshot: LegacyImportApplicationSnapshot,
  status: LegacyImportApplicationReceipt["status"] = "replayed",
): LegacyImportApplicationReceipt | null {
  const aggregate = loadReplayAggregate(snapshot);
  if (!aggregate) return null;
  const plan = compileLegacyImportApplicationPlan(snapshot.input.preview);
  requireReplayAggregate(aggregate, snapshot, plan);
  return receiptFromAggregate(aggregate, snapshot, status);
}

function mapPreviewFailure(
  error: LegacyImportPreviewError | LegacyImportSourceError,
): LegacyImportApplicationError {
  const changed = !(error instanceof LegacyImportPreviewError)
    || error.code !== "LEGACY_IMPORT_PREVIEW_EXPECTED_INVALID";
  return new LegacyImportApplicationError(
    "preview",
    changed
      ? "LEGACY_IMPORT_APPLICATION_PREVIEW_CHANGED"
      : "LEGACY_IMPORT_APPLICATION_PREVIEW_INVALID",
    changed
      ? "legacy import Preview changed after approval"
      : "legacy import Preview is invalid",
    error.retryable,
    { cause_code: error.code },
  );
}

function mapBackupFailure(error: LegacyImportBackupError): LegacyImportApplicationError {
  const changed = error.code !== "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID";
  return new LegacyImportApplicationError(
    "backup",
    changed
      ? "LEGACY_IMPORT_APPLICATION_BACKUP_CHANGED"
      : "LEGACY_IMPORT_APPLICATION_BACKUP_INVALID",
    changed
      ? "legacy import backup changed after verification"
      : "legacy import backup is invalid",
    error.retryable,
    { cause_code: error.code },
  );
}

function mapBaseFailure(error: LegacyImportBaseSnapshotError): LegacyImportApplicationError {
  return new LegacyImportApplicationError(
    "transaction",
    "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
    "legacy import canonical base is unavailable or changed",
    false,
    { cause_code: error.code },
  );
}

function captureApplicationBase(): LegacyImportBaseSnapshot {
  try {
    return captureCurrentLegacyImportBaseSnapshot();
  } catch (error) {
    if (error instanceof LegacyImportBaseSnapshotError) throw mapBaseFailure(error);
    throw error;
  }
}

function requireSameBase(
  expected: LegacyImportBaseSnapshot,
  observed: LegacyImportBaseSnapshot,
): void {
  if (hashLegacyImportValue(expected) === hashLegacyImportValue(observed)) return;
  throw new LegacyImportApplicationError(
    "transaction",
    "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
    "legacy import canonical base changed after verification",
    false,
    {
      expected_relevant_rows_hash: expected.relevant_rows_hash,
      observed_relevant_rows_hash: observed.relevant_rows_hash,
      expected_revision: expected.authority.revision,
      observed_revision: observed.authority.revision,
      expected_authority_epoch: expected.authority.authority_epoch,
      observed_authority_epoch: observed.authority.authority_epoch,
    },
  );
}

function requireCoordinationIdle(): void {
  const db = getDb();
  const counts = {
    active_workers: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM workers WHERE status = 'active'",
    ).get()?.["count"] ?? 0),
    held_leases: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM milestone_leases WHERE status = 'held'",
    ).get()?.["count"] ?? 0),
    active_dispatches: Number(db.prepare(`SELECT COUNT(*) AS count FROM unit_dispatches
      WHERE status IN ('claimed', 'running')`).get()?.["count"] ?? 0),
    active_attempts: Number(db.prepare(`SELECT COUNT(*) AS count FROM workflow_execution_attempts
      WHERE attempt_state IN ('claimed', 'running')`).get()?.["count"] ?? 0),
  };
  if (Object.values(counts).some((count) => count !== 0)) {
    throw new LegacyImportApplicationError(
      "coordination",
      "LEGACY_IMPORT_APPLICATION_COORDINATION_ACTIVE",
      "legacy import cannot apply while workflow coordination is active",
      true,
      counts,
    );
  }
}

function importRequest(snapshot: LegacyImportApplicationSnapshot): ImportDomainOperationRequest {
  const invocation = snapshot.identity.replayIdentity.invocation;
  const preview = snapshot.input.preview.preview;
  return {
    operationType: LEGACY_IMPORT_APPLICATION_OPERATION_TYPE,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: preview.base_project_revision,
    expectedAuthorityEpoch: preview.base_authority_epoch,
    actorType: invocation.actorType,
    ...(invocation.actorId === null ? {} : { actorId: invocation.actorId }),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId === null ? {} : { traceId: invocation.traceId }),
    ...(invocation.turnId === null ? {} : { turnId: invocation.turnId }),
    payload: snapshot.input.preview,
  };
}

function mapTransactionFailure(error: unknown): LegacyImportApplicationError {
  if (error instanceof LegacyImportApplicationError) return error;
  if (error instanceof GSDError && error.code === GSD_IDEMPOTENCY_CONFLICT) {
    return new LegacyImportApplicationError(
      "replay",
      "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT",
      "legacy import idempotency identity conflicts with committed work",
      false,
    );
  }
  if (error instanceof GSDError && error.code === GSD_REVISION_CONFLICT) {
    const contention = /writer contention|database is locked/i.test(error.message);
    return new LegacyImportApplicationError(
      "transaction",
      contention
        ? "LEGACY_IMPORT_APPLICATION_WRITER_CONTENTION"
        : "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
      contention
        ? "legacy import writer is busy; retry the request"
        : "legacy import authority changed after approval",
      contention,
    );
  }
  return new LegacyImportApplicationError(
    "transaction",
    "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED",
    "legacy import Application transaction failed",
    false,
    error instanceof GSDError
      ? { cause_code: error.code }
      : error instanceof Error
        ? { cause_name: error.name }
        : {},
  );
}

/** Apply one approved legacy Preview as a single immutable Domain Operation. */
export function applyLegacyImport(input: unknown): LegacyImportApplicationReceipt {
  const snapshot = snapshotLegacyImportApplication(input);
  const existing = replayReceipt(snapshot);
  if (existing) return existing;

  const plan = compileLegacyImportApplicationPlan(snapshot.input.preview);
  requireDestructiveConsent(snapshot);
  let preview: LegacyImportPreviewArtifact;
  try {
    preview = revalidateLegacyImportPreview(snapshot.input.previewInput, snapshot.input.preview);
  } catch (error) {
    if (error instanceof LegacyImportBaseSnapshotError) throw mapBaseFailure(error);
    if (error instanceof LegacyImportPreviewError || error instanceof LegacyImportSourceError) {
      throw mapPreviewFailure(error);
    }
    throw error;
  }
  const base = captureApplicationBase();
  try {
    verifyLegacyImportBackupArtifact({ backup: snapshot.input.backup, preview, base });
  } catch (error) {
    if (error instanceof LegacyImportBackupError) throw mapBackupFailure(error);
    throw error;
  }

  let operation: DomainOperationResult;
  try {
    operation = executeImportDomainOperation(importRequest(snapshot), (context) => {
      const transactionalBase = captureApplicationBase();
      requireSameBase(base, transactionalBase);
      requireCoordinationIdle();
      reachApplicationBoundary("after-coordination");
      try {
        validateLegacyImportVerifiedBackup(snapshot.input.backup, { preview, base: transactionalBase });
      } catch (error) {
        if (error instanceof LegacyImportBackupError) throw mapBackupFailure(error);
        throw error;
      }
      reachApplicationBoundary("after-final-validation");
      const writerResult = applyLegacyImportApplicationPlan(context, plan);
      const applicationRelevantRowsHash = captureApplicationBase().relevant_rows_hash;
      reachApplicationBoundary("after-plan");
      try {
        insertLegacyImportApplicationReceipt(context, plan, preview, snapshot.input.backup);
      } catch (error) {
        throw new LegacyImportApplicationError(
          "receipt",
          "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
          "legacy import Application receipt could not be inserted",
          false,
          error instanceof LegacyImportApplicationError ? { cause_code: error.code } : {},
        );
      }
      reachApplicationBoundary("after-receipt");
      return {
        events: [{
          eventType: LEGACY_IMPORT_APPLICATION_EVENT_TYPE,
          entityType: "legacy-import",
          entityId: preview.preview.preview_id,
          payload: applicationEventPayload(
            snapshot,
            plan,
            applicationRelevantRowsHash,
            writerResult.instructionResults,
          ),
          destinations: ["projection"],
        }],
        projections: plan.projectionKeys.map((projectionKey) => ({
          projectionKey,
          projectionKind: legacyImportProjectionKind(projectionKey),
          rendererVersion: "v1",
        })),
      };
    });
  } catch (error) {
    const raced = replayReceipt(snapshot);
    if (raced) return raced;
    throw mapTransactionFailure(error);
  }

  const committed = replayReceipt(snapshot, operation.status);
  if (!committed) receiptInconsistent("legacy import committed without a durable Application receipt");
  return committed;
}
