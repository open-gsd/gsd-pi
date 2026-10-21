// Project/App: gsd-pi
// File Purpose: Strict public Domain Operation for irreversible project authority cutover.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  GSD_IDEMPOTENCY_CONFLICT,
  GSD_REVISION_CONFLICT,
  GSDError,
} from "./errors.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { databaseMaintenanceIntentPath } from "./database-maintenance-fence.js";
import { processStartIdentity } from "./process-start-identity.js";
import {
  _executeAuthorityCutoverDomainOperation,
  canonicalDomainJson,
  type AuthorityCutoverDomainOperationRequest,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb, getDbPath, readTransaction, SCHEMA_VERSION } from "./db/engine.js";
import { insertAuthorityCutoverReceipt } from "./db/writers/authority-recovery.js";
import {
  LEGACY_IMPORT_APPLICATION_EVENT_TYPE,
  LEGACY_IMPORT_APPLICATION_OPERATION_TYPE,
} from "./legacy-import-application.js";
import {
  inspectLegacyImportApplicationEvidence,
  LegacyImportApplicationEvidenceError,
  type LegacyImportApplicationEvidence,
} from "./legacy-import-application-evidence.js";
import { captureCurrentLegacyImportBaseSnapshot } from "./legacy-import-preview-base.js";

export const PROJECT_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const PROJECT_AUTHORITY_CUTOVER_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION = 1 as const;

export type ProjectAuthorityCutoverErrorCode =
  | "PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID"
  | "PROJECT_AUTHORITY_CUTOVER_SCHEMA_UNSUPPORTED"
  | "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT"
  | "PROJECT_AUTHORITY_CUTOVER_RECOVERY_ALREADY_RECORDED"
  | "PROJECT_AUTHORITY_CUTOVER_EVIDENCE_CHANGED"
  | "PROJECT_AUTHORITY_CUTOVER_CONSENT_REQUIRED"
  | "PROJECT_AUTHORITY_CUTOVER_COORDINATION_ACTIVE"
  | "PROJECT_AUTHORITY_CUTOVER_AUTHORITY_STALE"
  | "PROJECT_AUTHORITY_CUTOVER_REPLAY_CONFLICT"
  | "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION"
  | "PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED";

export class ProjectAuthorityCutoverError extends Error {
  readonly code: ProjectAuthorityCutoverErrorCode;
  readonly retryable: boolean;
  readonly evidence: Readonly<Record<string, DomainJsonValue>>;

  constructor(
    code: ProjectAuthorityCutoverErrorCode,
    message: string,
    retryable = false,
    evidence: Record<string, DomainJsonValue> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectAuthorityCutoverError";
    this.code = code;
    this.retryable = retryable;
    this.evidence = Object.freeze({ ...evidence });
  }
}

export interface ProjectAuthorityCutoverConsent {
  readonly consentSchemaVersion: typeof PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION;
  readonly decision: "proceed";
  readonly irreversibleAuthorityCutover: true;
  readonly evidenceHash: string;
}

export interface ProjectAuthorityCutoverInput {
  readonly invocation: Readonly<ExecutionInvocation>;
  readonly expectedRevision: number;
  readonly expectedAuthorityEpoch: number;
  readonly authorityContractVersion: typeof PROJECT_AUTHORITY_CONTRACT_VERSION;
  readonly evidenceHash: string;
  readonly consent: Readonly<ProjectAuthorityCutoverConsent>;
}

export interface ProjectAuthorityCutoverEvidence {
  readonly evidenceSchemaVersion: typeof PROJECT_AUTHORITY_CUTOVER_EVIDENCE_SCHEMA_VERSION;
  readonly projectId: string;
  readonly projectRootRealpath: string;
  readonly databaseSchemaVersion: number;
  readonly applicationOperationId: string;
  readonly applicationIdempotencyKey: string;
  readonly applicationActorType: string;
  readonly applicationActorId: string | null;
  readonly applicationSourceTransport: string;
  readonly applicationTraceId: string | null;
  readonly applicationTurnId: string | null;
  readonly applicationIdentityHash: string;
  readonly previewInputHash: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly backupArtifactHash: string;
  readonly backupId: string;
  readonly applicationRelevantRowsHash: string;
  readonly backupRef: string;
  readonly backupSha256: string;
  readonly backupByteSize: number;
  readonly backupSchemaVersion: number;
  readonly backupProjectRevision: number;
  readonly backupAuthorityEpoch: number;
  readonly backupQuickCheck: "ok";
  readonly backupVerifiedAt: string;
  readonly projectRevision: number;
  readonly authorityEpoch: number;
  readonly evidenceHash: string;
}

export interface ProjectAuthorityCutoverReceipt {
  readonly status: "committed" | "replayed";
  readonly operationId: string;
  readonly projectId: string;
  readonly authorityContractVersion: typeof PROJECT_AUTHORITY_CONTRACT_VERSION;
  readonly evidenceHash: string;
  readonly consentHash: string;
  readonly priorRevision: number;
  readonly resultingRevision: number;
  readonly priorAuthorityEpoch: number;
  readonly resultingAuthorityEpoch: number;
  // Filesystem-state (markdown) authority flips to the DB with this cutover.
  // Recorded on the receipt and in the durable cutover event payload; the
  // pre-cutover evidence shape is unchanged, so the evidence schema version
  // constant does not move.
  readonly filesystemStateAuthority: "db";
  readonly cutoverAt: string;
  readonly eventIds: readonly string[];
  readonly outboxIds: readonly number[];
  readonly projectionWorkIds: readonly string[];
}

type DbRow = Record<string, unknown>;

interface CutoverInputSnapshot {
  readonly invocation: ExecutionInvocation;
  readonly expectedRevision: number;
  readonly expectedAuthorityEpoch: number;
  readonly authorityContractVersion: typeof PROJECT_AUTHORITY_CONTRACT_VERSION;
  readonly evidenceHash: string;
  readonly consent: ProjectAuthorityCutoverConsent;
  readonly consentHash: string;
}

function fail(
  code: ProjectAuthorityCutoverErrorCode,
  message: string,
  retryable = false,
  evidence: Record<string, DomainJsonValue> = {},
): never {
  throw new ProjectAuthorityCutoverError(code, message, retryable, evidence);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return required.every((key) => Object.hasOwn(descriptors, key))
    && keys.every((key) => (
      (required.includes(key) || optional.includes(key))
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ));
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID", `${field} must be non-blank text`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  const hash = requireNonBlank(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID", `${field} must be a canonical SHA-256 digest`);
  }
  return hash;
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID", `${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function hashValue(value: DomainJsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalDomainJson(value)).digest("hex")}`;
}

function normalizeInvocation(value: unknown): ExecutionInvocation {
  if (!hasExactDataKeys(
    value,
    ["idempotencyKey", "sourceTransport", "actorType"],
    ["actorId", "traceId", "turnId"],
  )) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID", "cutover invocation does not satisfy the exact v1 contract");
  }
  const sourceTransport = value["sourceTransport"];
  if (sourceTransport !== "internal" && sourceTransport !== "pi-tool" && sourceTransport !== "workflow-mcp") {
    fail("PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID", "cutover invocation source transport is invalid");
  }
  const optional = (field: "actorId" | "traceId" | "turnId"): string | undefined => {
    const candidate = value[field];
    return candidate === undefined ? undefined : requireNonBlank(candidate, `invocation.${field}`);
  };
  const actorId = optional("actorId");
  const traceId = optional("traceId");
  const turnId = optional("turnId");
  return {
    idempotencyKey: requireNonBlank(value["idempotencyKey"], "invocation.idempotencyKey"),
    sourceTransport,
    actorType: requireNonBlank(value["actorType"], "invocation.actorType"),
    ...(actorId === undefined ? {} : { actorId }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function normalizeConsent(value: unknown, evidenceHash: string): ProjectAuthorityCutoverConsent {
  if (!hasExactDataKeys(value, [
    "consentSchemaVersion",
    "decision",
    "irreversibleAuthorityCutover",
    "evidenceHash",
  ])) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONSENT_REQUIRED", "explicit irreversible cutover Consent is required");
  }
  if (
    value["consentSchemaVersion"] !== PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION
    || value["decision"] !== "proceed"
    || value["irreversibleAuthorityCutover"] !== true
    || value["evidenceHash"] !== evidenceHash
  ) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONSENT_REQUIRED", "cutover Consent must explicitly bind the current evidence");
  }
  return {
    consentSchemaVersion: PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
    decision: "proceed",
    irreversibleAuthorityCutover: true,
    evidenceHash,
  };
}

function snapshotInput(value: unknown): CutoverInputSnapshot {
  if (!hasExactDataKeys(value, [
    "invocation",
    "expectedRevision",
    "expectedAuthorityEpoch",
    "authorityContractVersion",
    "evidenceHash",
    "consent",
  ])) {
    fail("PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID", "authority cutover input does not satisfy the exact v1 contract");
  }
  if (value["authorityContractVersion"] !== PROJECT_AUTHORITY_CONTRACT_VERSION) {
    fail("PROJECT_AUTHORITY_CUTOVER_SCHEMA_UNSUPPORTED", "authority contract version is unsupported");
  }
  const evidenceHash = requireHash(value["evidenceHash"], "evidenceHash");
  const consent = normalizeConsent(value["consent"], evidenceHash);
  const expectedRevision = requireNonNegativeSafeInteger(value["expectedRevision"], "expectedRevision");
  const expectedAuthorityEpoch = requireNonNegativeSafeInteger(
    value["expectedAuthorityEpoch"],
    "expectedAuthorityEpoch",
  );
  if (expectedRevision === Number.MAX_SAFE_INTEGER || expectedAuthorityEpoch === Number.MAX_SAFE_INTEGER) {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_CONTRACT_INVALID",
      "authority cutover requires safe integer increment headroom",
    );
  }
  return Object.freeze({
    invocation: normalizeInvocation(value["invocation"]),
    expectedRevision,
    expectedAuthorityEpoch,
    authorityContractVersion: PROJECT_AUTHORITY_CONTRACT_VERSION,
    evidenceHash,
    consent,
    consentHash: hashValue({ ...consent }),
  });
}

function currentSchemaVersion(): number {
  const row = getDb().prepare("SELECT MAX(version) AS version FROM schema_version").get();
  return Number(row?.["version"] ?? -1);
}

function loadCurrentApplication(): {
  evidence: LegacyImportApplicationEvidence;
  revision: number;
  authorityEpoch: number;
} {
  const row = getDb().prepare(`
    SELECT authority.revision, authority.authority_epoch, operation.operation_id
    FROM project_authority authority
    JOIN workflow_operations operation
      ON operation.project_id = authority.project_id
     AND operation.resulting_revision = authority.revision
     AND operation.resulting_authority_epoch = authority.authority_epoch
     AND operation.operation_type = '${LEGACY_IMPORT_APPLICATION_OPERATION_TYPE}'
    WHERE authority.singleton = 1
  `).get() as DbRow | undefined;
  if (
    !row
    || typeof row["operation_id"] !== "string"
    || !Number.isSafeInteger(row["revision"])
    || !Number.isSafeInteger(row["authority_epoch"])
  ) {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT",
      "authority cutover requires the current canonical head to be one Import Application",
    );
  }
  try {
    return {
      evidence: inspectLegacyImportApplicationEvidence(row["operation_id"]),
      revision: Number(row["revision"]),
      authorityEpoch: Number(row["authority_epoch"]),
    };
  } catch (error) {
    if (!(error instanceof LegacyImportApplicationEvidenceError)) throw error;
    fail(
      "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT",
      "current Import Application evidence is malformed",
    );
  }
}

function requireNoRecordedRecovery(applicationOperationId: string): void {
  const row = getDb().prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM workflow_import_restores
        WHERE application_operation_id = :application_operation_id
      ) AS restored,
      EXISTS (
        SELECT 1 FROM workflow_import_forward_repairs
        WHERE application_operation_id = :application_operation_id
      ) AS repaired
  `).get({ ":application_operation_id": applicationOperationId });
  if (row?.["restored"] === 1 || row?.["repaired"] === 1) {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_RECOVERY_ALREADY_RECORDED",
      "Import Application recovery already selected a terminal route",
    );
  }
}

export function inspectProjectAuthorityCutoverEvidence(): ProjectAuthorityCutoverEvidence {
  return readTransaction(() => {
    const schemaVersion = currentSchemaVersion();
    if (schemaVersion !== SCHEMA_VERSION) {
      fail(
        "PROJECT_AUTHORITY_CUTOVER_SCHEMA_UNSUPPORTED",
        "authority cutover requires the current supported database schema",
        false,
        { expectedSchemaVersion: SCHEMA_VERSION, observedSchemaVersion: schemaVersion },
      );
    }
    const current = loadCurrentApplication();
    const application = current.evidence;
    if (captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash
      !== application.applicationRelevantRowsHash) {
      fail(
        "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT",
        "current canonical rows no longer match the Import Application result",
      );
    }
    const applicationOperationId = application.operationId;
    requireNoRecordedRecovery(applicationOperationId);
    const evidenceWithoutHash = {
      evidenceSchemaVersion: PROJECT_AUTHORITY_CUTOVER_EVIDENCE_SCHEMA_VERSION,
      projectId: application.projectId,
      projectRootRealpath: application.projectRootRealpath,
      databaseSchemaVersion: schemaVersion,
      applicationOperationId,
      applicationIdempotencyKey: application.idempotencyKey,
      applicationActorType: application.actorType,
      applicationActorId: application.actorId,
      applicationSourceTransport: application.sourceTransport,
      applicationTraceId: application.traceId,
      applicationTurnId: application.turnId,
      applicationIdentityHash: application.applicationIdentityHash,
      previewInputHash: application.previewInputHash,
      previewId: application.preview.preview.preview_id,
      previewHash: application.preview.preview_hash,
      backupArtifactHash: application.backupArtifactHash,
      backupId: application.backupId,
      applicationRelevantRowsHash: application.applicationRelevantRowsHash,
      backupRef: application.backupRef,
      backupSha256: application.backupSha256,
      backupByteSize: application.backupByteSize,
      backupSchemaVersion: application.backupSchemaVersion,
      backupProjectRevision: application.backupProjectRevision,
      backupAuthorityEpoch: application.backupAuthorityEpoch,
      backupQuickCheck: application.backupQuickCheck,
      backupVerifiedAt: application.backupVerifiedAt,
      projectRevision: current.revision,
      authorityEpoch: current.authorityEpoch,
    } satisfies Omit<ProjectAuthorityCutoverEvidence, "evidenceHash">;
    return Object.freeze({
      ...evidenceWithoutHash,
      evidenceHash: hashValue(evidenceWithoutHash),
    });
  });
}

function requireCoordinationIdle(projectRootRealpath: string): void {
  const counts = {
    activeWorkers: Number(getDb().prepare(`SELECT COUNT(*) AS count FROM workers
      WHERE project_root_realpath = :project_root_realpath AND status = 'active'`)
      .get({ ":project_root_realpath": projectRootRealpath })?.["count"] ?? 0),
    heldLeases: Number(getDb().prepare(
      "SELECT COUNT(*) AS count FROM milestone_leases WHERE status = 'held'",
    ).get()?.["count"] ?? 0),
    activeDispatches: Number(getDb().prepare(`SELECT COUNT(*) AS count FROM unit_dispatches
      WHERE status IN ('claimed', 'running')`).get()?.["count"] ?? 0),
    activeAttempts: Number(getDb().prepare(`SELECT COUNT(*) AS count FROM workflow_execution_attempts
      WHERE attempt_state IN ('claimed', 'running')`).get()?.["count"] ?? 0),
  };
  if (Object.values(counts).some((count) => count !== 0)) {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_COORDINATION_ACTIVE",
      "authority cutover requires quiescent workflow coordination",
      true,
      counts,
    );
  }
}

function loadAndValidateCutoverReceipt(
  operation: Readonly<DomainOperationResult>,
): ProjectAuthorityCutoverReceipt {
  const operationId = operation.operationId;
  const row = getDb().prepare(`
    SELECT operation.project_id, operation.expected_revision, operation.resulting_revision,
           operation.expected_authority_epoch, operation.resulting_authority_epoch,
           receipt.authority_contract_version, receipt.evidence_hash, receipt.consent_hash,
           receipt.cutover_at
    FROM workflow_operations operation
    JOIN workflow_authority_cutovers receipt ON receipt.operation_id = operation.operation_id
    WHERE operation.operation_id = :operation_id
      AND operation.operation_type = 'authority.cutover'
  `).get({ ":operation_id": operationId });
  if (!row) {
    fail("PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED", "authority cutover receipt is missing");
  }
  const events = getDb().prepare(`
    SELECT event_id, event_index, project_id, project_revision, authority_epoch,
           event_type, entity_type, entity_id, caused_by_event_id, payload_json, created_at
    FROM workflow_domain_events WHERE operation_id = :operation_id
    ORDER BY event_index
  `).all({ ":operation_id": operationId });
  const outbox = getDb().prepare(`
    SELECT outbox.outbox_id, outbox.event_id, outbox.destination
    FROM workflow_outbox outbox
    JOIN workflow_domain_events event ON event.event_id = outbox.event_id
    WHERE event.operation_id = :operation_id
    ORDER BY outbox.outbox_id
  `).all({ ":operation_id": operationId });
  const projections = getDb().prepare(`
    SELECT projection_work_id, project_id, projection_key, projection_kind,
           source_project_revision, source_authority_epoch, renderer_version,
           enqueue_operation_id, created_at, updated_at
    FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id
    ORDER BY projection_work_id
  `).all({ ":operation_id": operationId });
  let payload: DbRow | null = null;
  try {
    const parsed = JSON.parse(String(events[0]?.["payload_json"]));
    payload = isPlainRecord(parsed) ? parsed : null;
  } catch {
    payload = null;
  }
  const applicationOperationId = payload?.["applicationOperationId"];
  const application = typeof applicationOperationId === "string"
    ? getDb().prepare(`
        SELECT application_operation.project_id,
               application_operation.resulting_revision,
               application_operation.resulting_authority_epoch,
               application_event.payload_json
        FROM workflow_operations application_operation
        JOIN workflow_import_applications application
          ON application.operation_id = application_operation.operation_id
         AND application.project_id = application_operation.project_id
         AND application.resulting_project_revision = application_operation.resulting_revision
         AND application.resulting_authority_epoch = application_operation.resulting_authority_epoch
        JOIN workflow_domain_events application_event
          ON application_event.operation_id = application_operation.operation_id
         AND application_event.event_index = 0
         AND application_event.event_type = '${LEGACY_IMPORT_APPLICATION_EVENT_TYPE}'
         AND application_event.project_id = application_operation.project_id
         AND application_event.project_revision = application_operation.resulting_revision
         AND application_event.authority_epoch = application_operation.resulting_authority_epoch
         AND application_event.entity_type = 'legacy-import'
         AND application_event.entity_id = application.preview_id
         AND application_event.caused_by_event_id IS NULL
         AND application_event.created_at = application.applied_at
        WHERE application_operation.operation_id = :operation_id
          AND application_operation.operation_type = '${LEGACY_IMPORT_APPLICATION_OPERATION_TYPE}'
          AND (SELECT COUNT(*) FROM workflow_domain_events application_events
               WHERE application_events.operation_id = application_operation.operation_id) = 1
      `).get({ ":operation_id": applicationOperationId })
    : undefined;
  let applicationPayloadValue: DbRow | null = null;
  try {
    const parsed = JSON.parse(String(application?.["payload_json"]));
    applicationPayloadValue = isPlainRecord(parsed) ? parsed : null;
  } catch {
    applicationPayloadValue = null;
  }
  const exactAggregate =
    operation.eventIds.length === 1
    && operation.outboxIds.length === 1
    && operation.projectionWorkIds.length === 1
    && events.length === 1
    && outbox.length === 1
    && projections.length === 1
    && events[0]?.["event_id"] === operation.eventIds[0]
    && events[0]?.["event_index"] === 0
    && events[0]?.["project_id"] === row["project_id"]
    && events[0]?.["project_revision"] === row["resulting_revision"]
    && events[0]?.["authority_epoch"] === row["resulting_authority_epoch"]
    && events[0]?.["event_type"] === "authority.cutover"
    && events[0]?.["entity_type"] === "project"
    && events[0]?.["entity_id"] === row["project_id"]
    && events[0]?.["caused_by_event_id"] === null
    && events[0]?.["created_at"] === row["cutover_at"]
    && hasExactDataKeys(payload, [
      "authorityContractVersion",
      "applicationOperationId",
      "applicationIdentityHash",
      "evidenceHash",
      "consentHash",
      "filesystemStateAuthority",
      "priorRevision",
      "resultingRevision",
      "priorAuthorityEpoch",
      "resultingAuthorityEpoch",
    ])
    && payload?.["authorityContractVersion"] === row["authority_contract_version"]
    && payload?.["filesystemStateAuthority"] === "db"
    && application?.["project_id"] === row["project_id"]
    && application?.["resulting_revision"] === row["expected_revision"]
    && application?.["resulting_authority_epoch"] === row["expected_authority_epoch"]
    && applicationPayloadValue?.["applicationIdentityHash"]
      === payload?.["applicationIdentityHash"]
    && payload?.["evidenceHash"] === row["evidence_hash"]
    && payload?.["consentHash"] === row["consent_hash"]
    && payload?.["priorRevision"] === row["expected_revision"]
    && payload?.["resultingRevision"] === row["resulting_revision"]
    && payload?.["priorAuthorityEpoch"] === row["expected_authority_epoch"]
    && payload?.["resultingAuthorityEpoch"] === row["resulting_authority_epoch"]
    && outbox[0]?.["outbox_id"] === operation.outboxIds[0]
    && outbox[0]?.["event_id"] === operation.eventIds[0]
    && outbox[0]?.["destination"] === "projection"
    && projections[0]?.["projection_work_id"] === operation.projectionWorkIds[0]
    && projections[0]?.["project_id"] === row["project_id"]
    && projections[0]?.["projection_key"] === "project/authority"
    && projections[0]?.["projection_kind"] === "state"
    && projections[0]?.["source_project_revision"] === row["resulting_revision"]
    && projections[0]?.["source_authority_epoch"] === row["resulting_authority_epoch"]
    && projections[0]?.["renderer_version"] === "1"
    && projections[0]?.["enqueue_operation_id"] === operationId
    && projections[0]?.["created_at"] === row["cutover_at"]
    && projections[0]?.["updated_at"] === row["cutover_at"];
  if (!exactAggregate) {
    fail("PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED", "authority cutover lineage is incomplete or inconsistent");
  }
  return Object.freeze({
    status: operation.status,
    operationId,
    projectId: String(row["project_id"]),
    authorityContractVersion: Number(row["authority_contract_version"]) as 1,
    evidenceHash: String(row["evidence_hash"]),
    consentHash: String(row["consent_hash"]),
    priorRevision: Number(row["expected_revision"]),
    resultingRevision: Number(row["resulting_revision"]),
    priorAuthorityEpoch: Number(row["expected_authority_epoch"]),
    resultingAuthorityEpoch: Number(row["resulting_authority_epoch"]),
    filesystemStateAuthority: "db",
    cutoverAt: String(row["cutover_at"]),
    eventIds: Object.freeze([...operation.eventIds]),
    outboxIds: Object.freeze([...operation.outboxIds]),
    projectionWorkIds: Object.freeze([...operation.projectionWorkIds]),
  });
}

function mapFailure(error: unknown): ProjectAuthorityCutoverError {
  if (error instanceof ProjectAuthorityCutoverError) return error;
  if (error instanceof GSDError && error.code === GSD_IDEMPOTENCY_CONFLICT) {
    return new ProjectAuthorityCutoverError(
      "PROJECT_AUTHORITY_CUTOVER_REPLAY_CONFLICT",
      "authority cutover idempotency identity conflicts with committed work",
      false,
      {},
      { cause: error },
    );
  }
  if (error instanceof GSDError && error.code === GSD_REVISION_CONFLICT) {
    const contention = /writer contention|database is locked/i.test(error.message);
    return new ProjectAuthorityCutoverError(
      contention
        ? "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION"
        : "PROJECT_AUTHORITY_CUTOVER_AUTHORITY_STALE",
      contention
        ? "authority cutover writer is busy; retry the exact request"
        : "authority changed before cutover",
      contention,
      {},
      { cause: error },
    );
  }
  return new ProjectAuthorityCutoverError(
    "PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED",
    "authority cutover transaction failed",
    false,
    {},
    { cause: error },
  );
}

/**
 * Op-entry ownership assertion: the atomic flip runs inside the startup
 * EXCLUSIVE claim, so this process must either hold the database maintenance
 * intent itself or face no live foreign claimant. The ownership proof mirrors
 * how startup maintenance asserts ownership (readDatabaseMaintenanceIntent /
 * databaseMaintenanceOwnerIsActive in db/engine.ts): no intent file means the
 * claim is uncontested; an intent owned by this process means the startup
 * EXCLUSIVE window is held here; an intent whose owner is dead or whose
 * process-start identity moved on (PID reuse) is stale and adoptable at the
 * next open. Anything else — a live foreign owner, or an intent that cannot
 * be proven — fails closed as writer contention (retryable).
 */
function assertStartupExclusiveOwnership(): void {
  const databasePath = getDbPath();
  if (databasePath === null || databasePath === ":memory:") return;
  let raw: string;
  try {
    raw = readFileSync(databaseMaintenanceIntentPath(databasePath), "utf8");
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return;
    fail(
      "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION",
      "authority cutover cannot prove the startup EXCLUSIVE ownership state",
      true,
    );
  }
  let intent: unknown;
  try {
    intent = JSON.parse(raw);
  } catch {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION",
      "authority cutover found a malformed database maintenance intent",
      true,
    );
  }
  const record = intent as Record<string, unknown>;
  const ownerPid = Number(record["ownerPid"]);
  const ownerIdentity = record["ownerProcessStartIdentity"];
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || typeof ownerIdentity !== "string") {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION",
      "authority cutover found an invalid database maintenance intent",
      true,
    );
  }
  // Our own pid: a matching identity is the startup EXCLUSIVE claim held by
  // this process; a mismatched one is a stale claim from a previous process
  // instance that carried this pid. Both allow the cutover to proceed.
  if (ownerPid === process.pid) return;
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ESRCH") return;
  }
  const currentIdentity = processStartIdentity(ownerPid);
  if (currentIdentity === null || currentIdentity === ownerIdentity) {
    fail(
      "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION",
      "authority cutover requires the startup EXCLUSIVE claim; a live maintenance owner holds it",
      true,
      { ownerPid },
    );
  }
  // PID reused by an unrelated process instance: the claim is stale.
}

export function cutoverProjectAuthority(input: unknown): ProjectAuthorityCutoverReceipt {
  assertStartupExclusiveOwnership();
  const snapshot = snapshotInput(input);
  const invocation = snapshot.invocation;
  const request: AuthorityCutoverDomainOperationRequest = {
    operationType: "authority.cutover",
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: snapshot.expectedRevision,
    expectedAuthorityEpoch: snapshot.expectedAuthorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId === undefined ? {} : { actorId: invocation.actorId }),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
    ...(invocation.turnId === undefined ? {} : { turnId: invocation.turnId }),
    payload: {
      authorityContractVersion: snapshot.authorityContractVersion,
      evidenceHash: snapshot.evidenceHash,
      consentHash: snapshot.consentHash,
    },
  };
  try {
    const operation = _executeAuthorityCutoverDomainOperation(request, (context) => {
      const observed = inspectProjectAuthorityCutoverEvidence();
      if (
        observed.evidenceHash !== snapshot.evidenceHash
        || observed.projectRevision !== snapshot.expectedRevision
        || observed.authorityEpoch !== snapshot.expectedAuthorityEpoch
      ) {
        fail(
          "PROJECT_AUTHORITY_CUTOVER_EVIDENCE_CHANGED",
          "authority cutover evidence changed before commit",
          false,
          {
            expectedEvidenceHash: snapshot.evidenceHash,
            observedEvidenceHash: observed.evidenceHash,
          },
        );
      }
      requireCoordinationIdle(observed.projectRootRealpath);
      insertAuthorityCutoverReceipt(context, {
        authorityContractVersion: snapshot.authorityContractVersion,
        evidenceHash: snapshot.evidenceHash,
        consentHash: snapshot.consentHash,
      });
      return {
        events: [{
          eventType: "authority.cutover",
          entityType: "project",
          entityId: context.projectId,
          payload: {
            authorityContractVersion: snapshot.authorityContractVersion,
            applicationOperationId: observed.applicationOperationId,
            applicationIdentityHash: observed.applicationIdentityHash,
            evidenceHash: snapshot.evidenceHash,
            consentHash: snapshot.consentHash,
            filesystemStateAuthority: "db",
            priorRevision: snapshot.expectedRevision,
            resultingRevision: context.resultingRevision,
            priorAuthorityEpoch: snapshot.expectedAuthorityEpoch,
            resultingAuthorityEpoch: context.resultingAuthorityEpoch,
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: "project/authority",
          projectionKind: "state",
          rendererVersion: "1",
        }],
      };
    });
    const receipt = loadAndValidateCutoverReceipt(operation);
    if (
      receipt.authorityContractVersion !== snapshot.authorityContractVersion
      || receipt.evidenceHash !== snapshot.evidenceHash
      || receipt.consentHash !== snapshot.consentHash
      || receipt.priorRevision !== snapshot.expectedRevision
      || receipt.priorAuthorityEpoch !== snapshot.expectedAuthorityEpoch
      || receipt.resultingRevision !== snapshot.expectedRevision + 1
      || receipt.resultingAuthorityEpoch !== snapshot.expectedAuthorityEpoch + 1
    ) {
      fail("PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED", "authority cutover receipt conflicts with its request");
    }
    return receipt;
  } catch (error) {
    throw mapFailure(error);
  }
}
