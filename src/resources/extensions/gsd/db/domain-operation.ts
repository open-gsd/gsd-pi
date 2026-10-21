// Project/App: gsd-pi
// File Purpose: Atomic, revision-checked Domain Operation writer boundary.

import { createHash, randomUUID } from "node:crypto";

import {
  GSD_IDEMPOTENCY_CONFLICT,
  GSD_REVISION_CONFLICT,
  GSDError,
} from "../errors.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  isStrictLegacyImportData,
  isValidLegacyImportPreviewArtifact,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.js";
import type { LegacyImportForwardRepairPlan } from "../legacy-import-forward-repair-plan.js";
import type { LegacyImportValue } from "../legacy-import-contract.js";
import { isSqliteBusyError } from "../sqlite-errors.js";
import {
  assertDatabaseReplacementReceiptIntent,
  getDb,
  immediateTransaction,
  isInTransaction,
  withDatabaseReplacementWriteBypass,
  type DatabaseReplacementReceiptCapability,
} from "./engine.js";

export type DomainJsonValue =
  | null
  | boolean
  | number
  | string
  | DomainJsonValue[]
  | { [key: string]: DomainJsonValue };

export interface DomainOperationRequest {
  operationType: string;
  idempotencyKey: string;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  actorType: string;
  actorId?: string;
  sourceTransport: string;
  traceId?: string;
  turnId?: string;
  payload: DomainJsonValue;
}

export type ImportDomainOperationRequest = Omit<
  DomainOperationRequest,
  "operationType" | "payload"
> & {
  operationType: "import.apply";
  payload: LegacyImportPreviewArtifact;
};

export type AuthorityCutoverDomainOperationRequest = Omit<
  DomainOperationRequest,
  "operationType"
> & {
  operationType: "authority.cutover";
};

export interface ImportRestoreReceiptContract {
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly applicationResultingProjectRevision: number;
  readonly applicationResultingAuthorityEpoch: number;
  readonly erasedLineageHash: string;
  readonly erasedLineageJson: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly backupId: string;
  readonly backupSha256: string;
  readonly backupByteSize: number;
  readonly backupSchemaVersion: number;
  readonly backupProjectRevision: number;
  readonly backupAuthorityEpoch: number;
  readonly differenceHash: string;
  readonly consentHash: string;
  readonly verificationHash: string;
}

export type ImportRestoreDomainOperationRequest = Omit<
  DomainOperationRequest,
  "operationType" | "payload"
> & {
  operationType: "import.restore";
  payload: ImportRestoreReceiptContract;
};

export type ImportForwardRepairDomainOperationRequest = Omit<
  DomainOperationRequest,
  "operationType" | "payload"
> & {
  operationType: "import.forward_repair";
  payload: LegacyImportForwardRepairPlan;
};

interface AuthorityCutoverReceiptContract {
  readonly authorityContractVersion: number;
  readonly evidenceHash: string;
  readonly consentHash: string;
}

const IMPORT_RESTORE_RECEIPT_KEYS = [
  "applicationOperationId",
  "applicationIdentityHash",
  "applicationResultingProjectRevision",
  "applicationResultingAuthorityEpoch",
  "erasedLineageHash",
  "erasedLineageJson",
  "previewId",
  "previewHash",
  "backupId",
  "backupSha256",
  "backupByteSize",
  "backupSchemaVersion",
  "backupProjectRevision",
  "backupAuthorityEpoch",
  "differenceHash",
  "consentHash",
  "verificationHash",
] as const satisfies readonly (keyof ImportRestoreReceiptContract)[];

type DomainOperationRequestIdentity = Omit<DomainOperationRequest, "payload">;

export interface DomainOperationEventInput {
  eventType: string;
  entityType: string;
  entityId: string;
  payload: DomainJsonValue;
  destinations: string[];
  causedByEventIndex?: number;
}

export interface DomainOperationProjectionInput {
  projectionKey: string;
  projectionKind: string;
  rendererVersion: string;
}

export interface DomainOperationMutation {
  events: DomainOperationEventInput[];
  projections: DomainOperationProjectionInput[];
}

export interface DomainOperationContext {
  operationId: string;
  projectId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
}

export interface DomainOperationResult {
  status: "committed" | "replayed";
  operationId: string;
  projectId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  requestHash: string;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
}

export type DomainOperationFaultPoint =
  | "after-operation"
  | "after-mutation"
  | "after-events"
  | "after-outbox"
  | "after-projections"
  | "before-cas"
  | "after-commit";

interface AuthorityRow {
  project_id: string;
  revision: number;
  authority_epoch: number;
}

interface OperationRow {
  operation_id: string;
  project_id: string;
  operation_type: string;
  idempotency_key: string;
  expected_revision: number;
  resulting_revision: number;
  expected_authority_epoch: number;
  resulting_authority_epoch: number;
  actor_type: string;
  actor_id: string | null;
  source_transport: string;
  trace_id: string | null;
  turn_id: string | null;
  request_hash: string;
  created_at: string;
}

let faultPoint: DomainOperationFaultPoint | null = null;
let faultOperationType: string | null = null;

export function _setDomainOperationFaultForTest(
  point: DomainOperationFaultPoint | null,
  operationType: string | null = null,
): void {
  faultPoint = point;
  faultOperationType = operationType;
}

function hitFault(point: DomainOperationFaultPoint, operationType: string): void {
  if (faultPoint === point && (faultOperationType === null || faultOperationType === operationType)) {
    throw new Error(`domain operation fault: ${point}`);
  }
}

function requireNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function snapshotAuthorityCutoverReceiptContract(payload: unknown): AuthorityCutoverReceiptContract {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("authority cutover payload must be the exact receipt contract");
  }
  const descriptors = Object.getOwnPropertyDescriptors(payload);
  const keys = Object.keys(descriptors);
  const expected = ["authorityContractVersion", "evidenceHash", "consentHash"];
  if (
    Object.getPrototypeOf(payload) !== Object.prototype
    || Object.getOwnPropertySymbols(payload).length !== 0
    || keys.length !== expected.length
    || !expected.every((key) => (
      Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ))
  ) {
    throw new Error("authority cutover payload must be the exact receipt contract");
  }
  const authorityContractVersion = descriptors["authorityContractVersion"]?.value as unknown;
  const evidenceHash = descriptors["evidenceHash"]?.value as unknown;
  const consentHash = descriptors["consentHash"]?.value as unknown;
  if (!Number.isSafeInteger(authorityContractVersion) || Number(authorityContractVersion) < 1) {
    throw new Error("authority cutover contract version must be a positive safe integer");
  }
  if (
    typeof evidenceHash !== "string"
    || typeof consentHash !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(evidenceHash)
    || !/^sha256:[0-9a-f]{64}$/.test(consentHash)
  ) {
    throw new Error("authority cutover receipt hashes must be canonical SHA-256 digests");
  }
  return Object.freeze({
    authorityContractVersion: Number(authorityContractVersion),
    evidenceHash,
    consentHash,
  });
}

function snapshotImportRestoreReceiptContract(payload: unknown): ImportRestoreReceiptContract {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("import restore payload must be the exact receipt contract");
  }
  const descriptors = Object.getOwnPropertyDescriptors(payload);
  const keys = Object.keys(descriptors);
  if (
    Object.getPrototypeOf(payload) !== Object.prototype
    || Object.getOwnPropertySymbols(payload).length !== 0
    || keys.length !== IMPORT_RESTORE_RECEIPT_KEYS.length
    || !IMPORT_RESTORE_RECEIPT_KEYS.every((key) => (
      Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ))
  ) {
    throw new Error("import restore payload must be the exact receipt contract");
  }

  const value = Object.fromEntries(IMPORT_RESTORE_RECEIPT_KEYS.map((key) => [
    key,
    descriptors[key]?.value,
  ])) as unknown as ImportRestoreReceiptContract;
  requireNonBlank(value.applicationOperationId, "applicationOperationId");
  requireNonBlank(value.previewId, "previewId");
  for (const field of [
    "applicationIdentityHash",
    "erasedLineageHash",
    "previewHash",
    "backupId",
    "backupSha256",
    "differenceHash",
    "consentHash",
    "verificationHash",
  ] as const) {
    if (typeof value[field] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value[field])) {
      throw new Error(`${field} must be a canonical SHA-256 digest`);
    }
  }
  requireNonNegativeSafeInteger(
    value.applicationResultingProjectRevision,
    "applicationResultingProjectRevision",
  );
  if (value.applicationResultingProjectRevision === 0) {
    throw new Error("applicationResultingProjectRevision must be positive");
  }
  requireNonNegativeSafeInteger(
    value.applicationResultingAuthorityEpoch,
    "applicationResultingAuthorityEpoch",
  );
  requireNonNegativeSafeInteger(value.backupByteSize, "backupByteSize");
  if (value.backupByteSize === 0) throw new Error("backupByteSize must be positive");
  requireNonNegativeSafeInteger(value.backupSchemaVersion, "backupSchemaVersion");
  if (value.backupSchemaVersion === 0) throw new Error("backupSchemaVersion must be positive");
  requireNonNegativeSafeInteger(value.backupProjectRevision, "backupProjectRevision");
  requireNonNegativeSafeInteger(value.backupAuthorityEpoch, "backupAuthorityEpoch");
  if (
    value.applicationResultingProjectRevision !== value.backupProjectRevision + 1
    || value.applicationResultingAuthorityEpoch !== value.backupAuthorityEpoch
  ) {
    throw new Error("import restore Application authority must match the backup successor");
  }

  let lineage: unknown;
  try {
    lineage = JSON.parse(value.erasedLineageJson);
  } catch {
    throw new Error("erasedLineageJson must be canonical JSON");
  }
  if (
    lineage === null
    || typeof lineage !== "object"
    || Array.isArray(lineage)
    || Object.getPrototypeOf(lineage) !== Object.prototype
    || canonicalLegacyImportJson(lineage) !== value.erasedLineageJson
    || hashLegacyImportValue(lineage) !== value.erasedLineageHash
  ) {
    throw new Error("erased import lineage must be canonical and hash-bound");
  }
  const lineageRecord = lineage as Record<string, unknown>;
  const lineageKeys = Object.keys(lineageRecord);
  const expectedLineageKeys = [
    "applicationIdentityHash",
    "applicationOperationId",
    "applicationResultingAuthorityEpoch",
    "applicationResultingProjectRevision",
    "schemaVersion",
  ];
  if (
    lineageKeys.length !== expectedLineageKeys.length
    || !expectedLineageKeys.every((key) => Object.hasOwn(lineageRecord, key))
    || lineageRecord["schemaVersion"] !== 1
    || lineageRecord["applicationOperationId"] !== value.applicationOperationId
    || lineageRecord["applicationIdentityHash"] !== value.applicationIdentityHash
    || lineageRecord["applicationResultingProjectRevision"]
      !== value.applicationResultingProjectRevision
    || lineageRecord["applicationResultingAuthorityEpoch"]
      !== value.applicationResultingAuthorityEpoch
  ) {
    throw new Error("erased import lineage must exactly match the receipt contract");
  }
  return Object.freeze({ ...value });
}

function requiredRequestDataProperty(request: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(request, field);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`${field} must be an own data property`);
  }
  return descriptor.value;
}

function optionalRequestDataProperty(request: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(request, field);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    throw new Error(`${field} must be an own data property`);
  }
  return descriptor.value;
}

function snapshotDomainOperationRequest(request: object): {
  identity: DomainOperationRequestIdentity;
  payload: unknown;
} {
  if (Object.hasOwn(request, "advanceAuthorityEpoch")) {
    throw new Error(
      "advanceAuthorityEpoch is not accepted; use the typed authority cutover operation",
    );
  }
  return {
    identity: {
      operationType: requiredRequestDataProperty(request, "operationType") as string,
      idempotencyKey: requiredRequestDataProperty(request, "idempotencyKey") as string,
      expectedRevision: requiredRequestDataProperty(request, "expectedRevision") as number,
      expectedAuthorityEpoch: requiredRequestDataProperty(request, "expectedAuthorityEpoch") as number,
      actorType: requiredRequestDataProperty(request, "actorType") as string,
      actorId: optionalRequestDataProperty(request, "actorId") as string | undefined,
      sourceTransport: requiredRequestDataProperty(request, "sourceTransport") as string,
      traceId: optionalRequestDataProperty(request, "traceId") as string | undefined,
      turnId: optionalRequestDataProperty(request, "turnId") as string | undefined,
    },
    payload: requiredRequestDataProperty(request, "payload"),
  };
}

export function canonicalDomainJson(value: DomainJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("domain operation JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalDomainJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object") throw new Error("domain operation payload must be JSON-compatible");

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("domain operation payload must contain plain JSON objects");
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDomainJson(entry)}`).join(",")}}`;
}

function validateRequestScalars(request: DomainOperationRequestIdentity): void {
  requireNonBlank(request.operationType, "operationType");
  requireNonBlank(request.idempotencyKey, "idempotencyKey");
  requireNonBlank(request.actorType, "actorType");
  requireNonBlank(request.sourceTransport, "sourceTransport");
  if (request.actorId !== undefined) requireNonBlank(request.actorId, "actorId");
  if (request.traceId !== undefined) requireNonBlank(request.traceId, "traceId");
  if (request.turnId !== undefined) requireNonBlank(request.turnId, "turnId");
  requireNonNegativeSafeInteger(request.expectedRevision, "expectedRevision");
  requireNonNegativeSafeInteger(request.expectedAuthorityEpoch, "expectedAuthorityEpoch");
  if (request.expectedRevision === Number.MAX_SAFE_INTEGER) {
    throw new Error("expectedRevision requires safe integer increment headroom");
  }
}

function requestHash(
  request: DomainOperationRequest,
  advanceAuthorityEpoch = false,
): string {
  const canonical = canonicalDomainJson({
    operationType: request.operationType,
    expectedRevision: request.expectedRevision,
    expectedAuthorityEpoch: request.expectedAuthorityEpoch,
    actorType: request.actorType,
    actorId: request.actorId ?? null,
    sourceTransport: request.sourceTransport,
    traceId: request.traceId ?? null,
    turnId: request.turnId ?? null,
    payload: request.payload,
    // Retain the explicit legacy false member so existing ordinary operations
    // keep their exact replay hash after the public epoch switch is removed.
    advanceAuthorityEpoch,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Recompute the hash an executor durably stored in workflow_operations
 * .request_hash. import.apply binds the operation to the sealed Preview
 * artifact hash (executeImportDomainOperation), and authority.cutover commits
 * with the epoch-advancing request hash (_executeAuthorityCutoverDomainOperation);
 * every other operation stores the conventional request hash.
 */
function storedRequestHash(request: DomainOperationRequest): string {
  if (request.operationType === "import.apply") {
    if (!isValidLegacyImportPreviewArtifact(request.payload)) {
      throw new Error("import.apply receipt verification requires the sealed Preview artifact payload");
    }
    return request.payload.preview_hash;
  }
  return requestHash(request, request.operationType === "authority.cutover");
}

function validateMutation(mutation: DomainOperationMutation): string[] {
  if (mutation.events.length === 0) throw new Error("domain operation requires at least one event");
  if (mutation.projections.length === 0) {
    throw new Error("domain operation requires at least one projection target");
  }
  if (mutation.projections.length > 10_000) {
    throw new Error("domain operation projection limit is 10,000 targets");
  }

  const eventPayloads = mutation.events.map((event, eventIndex) => {
    requireNonBlank(event.eventType, `events[${eventIndex}].eventType`);
    requireNonBlank(event.entityType, `events[${eventIndex}].entityType`);
    requireNonBlank(event.entityId, `events[${eventIndex}].entityId`);
    const payload = canonicalDomainJson(event.payload);
    if (event.destinations.length === 0) {
      throw new Error(`events[${eventIndex}] requires at least one outbox destination`);
    }
    const destinations = new Set<string>();
    for (const destination of event.destinations) {
      requireNonBlank(destination, `events[${eventIndex}].destinations`);
      if (destinations.has(destination)) {
        throw new Error(`events[${eventIndex}] contains duplicate destination ${destination}`);
      }
      destinations.add(destination);
    }
    if (
      event.causedByEventIndex !== undefined &&
      (!Number.isInteger(event.causedByEventIndex) ||
        event.causedByEventIndex < 0 ||
        event.causedByEventIndex >= eventIndex)
    ) {
      throw new Error(`events[${eventIndex}].causedByEventIndex must reference an earlier event`);
    }
    return payload;
  });

  const projectionKeys = new Set<string>();
  mutation.projections.forEach((projection, projectionIndex) => {
    requireNonBlank(projection.projectionKey, `projections[${projectionIndex}].projectionKey`);
    requireNonBlank(projection.projectionKind, `projections[${projectionIndex}].projectionKind`);
    requireNonBlank(projection.rendererVersion, `projections[${projectionIndex}].rendererVersion`);
    if (projection.projectionKey !== projection.projectionKey.trim().toLowerCase()) {
      throw new Error(`projections[${projectionIndex}].projectionKey must be normalized lowercase`);
    }
    if (projection.projectionKind !== projection.projectionKind.trim().toLowerCase()) {
      throw new Error(`projections[${projectionIndex}].projectionKind must be normalized lowercase`);
    }
    if (projectionKeys.has(projection.projectionKey)) {
      throw new Error(`duplicate projection key ${projection.projectionKey}`);
    }
    projectionKeys.add(projection.projectionKey);
  });
  return eventPayloads;
}

function loadReceipt(operation: OperationRow, status: DomainOperationResult["status"]): DomainOperationResult {
  const db = getDb();
  const eventIds = db.prepare(`
    SELECT event_id FROM workflow_domain_events
    WHERE operation_id = :operation_id ORDER BY event_index
  `).all({ ":operation_id": operation.operation_id }).map((row) => String(row["event_id"]));
  const unsafeOutbox = db.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM workflow_outbox outbox
      JOIN workflow_domain_events event ON event.event_id = outbox.event_id
      WHERE event.operation_id = :operation_id
        AND outbox.outbox_id > 9007199254740991
    ) AS unsafe
  `).get({ ":operation_id": operation.operation_id });
  if (unsafeOutbox?.["unsafe"] === 1) {
    throw new Error("stored outbox identity exceeds safe integer range");
  }
  const outboxIds = db.prepare(`
    SELECT outbox.outbox_id
    FROM workflow_outbox outbox
    JOIN workflow_domain_events event ON event.event_id = outbox.event_id
    WHERE event.operation_id = :operation_id
    ORDER BY outbox.outbox_id
  `).all({ ":operation_id": operation.operation_id }).map((row) => Number(row["outbox_id"]));
  const projectionWorkIds = db.prepare(`
    SELECT projection_work_id FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id ORDER BY projection_work_id
  `).all({ ":operation_id": operation.operation_id })
    .map((row) => String(row["projection_work_id"]));

  return {
    status,
    operationId: operation.operation_id,
    projectId: operation.project_id,
    resultingRevision: operation.resulting_revision,
    resultingAuthorityEpoch: operation.resulting_authority_epoch,
    requestHash: operation.request_hash,
    eventIds,
    outboxIds,
    projectionWorkIds,
  };
}

export function inspectDomainOperationReceipt(
  operationType: string,
  idempotencyKey: string,
): DomainOperationResult | null {
  const operation = getDb().prepare(`
    SELECT operation_id, project_id, operation_type, idempotency_key,
           expected_revision, resulting_revision,
           expected_authority_epoch, resulting_authority_epoch,
           actor_type, actor_id, source_transport, trace_id, turn_id, request_hash,
           created_at
    FROM workflow_operations
    WHERE operation_type = :operation_type AND idempotency_key = :idempotency_key
  `).get({
    ":operation_type": operationType,
    ":idempotency_key": idempotencyKey,
  }) as unknown as OperationRow | undefined;
  return operation ? loadReceipt(operation, "replayed") : null;
}

export function assertDomainOperationReceiptComponents(
  receipt: DomainOperationResult,
  request: DomainOperationRequest,
  mutation: DomainOperationMutation,
): void {
  const db = getDb();
  const operation = loadOperation(receipt.operationId);
  const headerMatches = operation !== undefined
    && operation.operation_id === receipt.operationId
    && operation.project_id === receipt.projectId
    && operation.resulting_revision === receipt.resultingRevision
    && operation.resulting_authority_epoch === receipt.resultingAuthorityEpoch
    && operation.request_hash === receipt.requestHash
    && operationMatchesRequest(operation, request, storedRequestHash(request));
  const events = db.prepare(`
    SELECT event_id, event_index, project_revision, authority_epoch, event_type,
           entity_type, entity_id, caused_by_event_id, payload_json
    FROM workflow_domain_events
    WHERE operation_id = :operation_id
    ORDER BY event_index
  `).all({ ":operation_id": receipt.operationId });
  const expectedEventIds = events.map((row) => String(row["event_id"]));
  const eventMatches = events.length === mutation.events.length && mutation.events.every((event, index) => {
    const row = events[index]!;
    const causedBy = event.causedByEventIndex === undefined
      ? null
      : expectedEventIds[event.causedByEventIndex] ?? null;
    return row["event_index"] === index
      && row["project_revision"] === receipt.resultingRevision
      && row["authority_epoch"] === receipt.resultingAuthorityEpoch
      && row["event_type"] === event.eventType
      && row["entity_type"] === event.entityType
      && row["entity_id"] === event.entityId
      && row["caused_by_event_id"] === causedBy
      && row["payload_json"] === canonicalLegacyImportJson(event.payload);
  });
  const outbox = db.prepare(`
    SELECT outbox.outbox_id, event.event_index, outbox.destination
    FROM workflow_outbox outbox
    JOIN workflow_domain_events event ON event.event_id = outbox.event_id
    WHERE event.operation_id = :operation_id
    ORDER BY outbox.outbox_id
  `).all({ ":operation_id": receipt.operationId });
  const expectedOutbox = mutation.events.flatMap((event, eventIndex) =>
    event.destinations.map((destination) => ({ eventIndex, destination })));
  const outboxMatches = outbox.length === expectedOutbox.length && expectedOutbox.every((expected, index) =>
    outbox[index]?.["event_index"] === expected.eventIndex
      && outbox[index]?.["destination"] === expected.destination);
  const projections = db.prepare(`
    SELECT projection_work_id, projection_key, projection_kind, source_project_revision,
           source_authority_epoch, renderer_version
    FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id
    ORDER BY projection_work_id
  `).all({ ":operation_id": receipt.operationId });
  const projectionMatches = projections.length === mutation.projections.length
    && mutation.projections.every((expected, index) => {
      const row = projections[index]!;
      return row["projection_work_id"] === `${receipt.operationId}:${String(index).padStart(4, "0")}`
        && row["projection_key"] === expected.projectionKey
        && row["projection_kind"] === expected.projectionKind
        && row["source_project_revision"] === receipt.resultingRevision
        && row["source_authority_epoch"] === receipt.resultingAuthorityEpoch
        && row["renderer_version"] === expected.rendererVersion;
    });
  if (!headerMatches
    || !eventMatches
    || !outboxMatches
    || !projectionMatches
    || JSON.stringify(receipt.eventIds) !== JSON.stringify(expectedEventIds)
    || JSON.stringify(receipt.outboxIds) !== JSON.stringify(outbox.map((row) => Number(row["outbox_id"])))
    || JSON.stringify(receipt.projectionWorkIds) !== JSON.stringify(projections.map((row) => String(row["projection_work_id"])))) {
    throw new Error("domain operation receipt components or header are incomplete or corrupt");
  }
}

function operationMatchesRequest(
  operation: OperationRow,
  request: DomainOperationRequestIdentity,
  hash: string,
): boolean {
  return (
    operation.operation_type === request.operationType &&
    operation.idempotency_key === request.idempotencyKey &&
    operation.request_hash === hash &&
    operation.expected_revision === request.expectedRevision &&
    operation.expected_authority_epoch === request.expectedAuthorityEpoch &&
    operation.actor_type === request.actorType &&
    operation.actor_id === (request.actorId ?? null) &&
    operation.source_transport === request.sourceTransport &&
    operation.trace_id === (request.traceId ?? null) &&
    operation.turn_id === (request.turnId ?? null)
  );
}

function requireReplayMatch(
  operation: OperationRow,
  request: DomainOperationRequestIdentity,
  hash: string,
): void {
  if (!operationMatchesRequest(operation, request, hash)) {
    throw new GSDError(
      GSD_IDEMPOTENCY_CONFLICT,
      `domain operation idempotency conflict for key ${request.idempotencyKey}`,
    );
  }
}

function loadOperation(operationId: string): OperationRow | undefined {
  return getDb().prepare(`
    SELECT operation_id, project_id, operation_type, idempotency_key,
           expected_revision, resulting_revision,
           expected_authority_epoch, resulting_authority_epoch,
           actor_type, actor_id, source_transport, trace_id, turn_id, request_hash,
           created_at
    FROM workflow_operations WHERE operation_id = :operation_id
  `).get({ ":operation_id": operationId }) as unknown as OperationRow | undefined;
}

function requireCommittedProvenance(
  operation: OperationRow | undefined,
  request: DomainOperationRequestIdentity,
  hash: string,
  context: DomainOperationContext,
  createdAt: string,
): OperationRow {
  if (!operation) throw new Error("domain operation provenance row is missing");
  const matches =
    operationMatchesRequest(operation, request, hash) &&
    operation.operation_id === context.operationId &&
    operation.project_id === context.projectId &&
    operation.resulting_revision === context.resultingRevision &&
    operation.resulting_authority_epoch === context.resultingAuthorityEpoch &&
    operation.created_at === createdAt;
  if (!matches) throw new Error("domain operation provenance changed during mutation");
  return operation;
}

function requireMatchingImportApplication(
  operation: OperationRow,
  artifact: LegacyImportPreviewArtifact,
): void {
  const preview = artifact.preview;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_import_applications
    WHERE operation_id = :operation_id
      AND project_id = :project_id
      AND import_kind = :import_kind
      AND importer_version = :importer_version
      AND preview_schema_version = :preview_schema_version
      AND preview_id = :preview_id
      AND preview_hash = :preview_hash
      AND base_project_revision = :base_project_revision
      AND base_authority_epoch = :base_authority_epoch
      AND base_database_schema_version = :base_database_schema_version
      AND source_set_hash = :source_set_hash
      AND change_set_hash = :change_set_hash
      AND create_count = :create_count
      AND update_count = :update_count
      AND delete_count = :delete_count
      AND preserve_count = :preserve_count
      AND unparsed_count = :unparsed_count
      AND unresolved_count = :unresolved_count
      AND preview_json = :preview_json
      AND resulting_project_revision = :resulting_project_revision
      AND resulting_authority_epoch = :resulting_authority_epoch
  `).get({
    ":operation_id": operation.operation_id,
    ":project_id": operation.project_id,
    ":import_kind": preview.import_kind,
    ":importer_version": preview.importer_version,
    ":preview_schema_version": preview.preview_schema_version,
    ":preview_id": preview.preview_id,
    ":preview_hash": artifact.preview_hash,
    ":base_project_revision": operation.expected_revision,
    ":base_authority_epoch": operation.expected_authority_epoch,
    ":base_database_schema_version": preview.base_database_schema_version,
    ":source_set_hash": preview.source_set_hash,
    ":change_set_hash": preview.change_set_hash,
    ":create_count": preview.counts.create,
    ":update_count": preview.counts.update,
    ":delete_count": preview.counts.delete,
    ":preserve_count": preview.counts.preserve,
    ":unparsed_count": preview.counts.unparsed,
    ":unresolved_count": preview.counts.unresolved,
    ":preview_json": canonicalLegacyImportJson(preview),
    ":resulting_project_revision": operation.resulting_revision,
    ":resulting_authority_epoch": operation.resulting_authority_epoch,
  });
  if (row?.["count"] !== 1) {
    throw new Error("import Domain Operation requires exactly one matching Application receipt");
  }
}

function requireMatchingAuthorityCutover(
  operation: OperationRow,
  contract: Readonly<AuthorityCutoverReceiptContract>,
): void {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_authority_cutovers
    WHERE operation_id = :operation_id
      AND project_id = :project_id
      AND authority_contract_version = :authority_contract_version
      AND evidence_hash = :evidence_hash
      AND consent_hash = :consent_hash
      AND cutover_at = :cutover_at
      AND resulting_project_revision = :resulting_project_revision
      AND resulting_authority_epoch = :resulting_authority_epoch
  `).get({
    ":operation_id": operation.operation_id,
    ":project_id": operation.project_id,
    ":authority_contract_version": contract.authorityContractVersion,
    ":evidence_hash": contract.evidenceHash,
    ":consent_hash": contract.consentHash,
    ":cutover_at": operation.created_at,
    ":resulting_project_revision": operation.resulting_revision,
    ":resulting_authority_epoch": operation.resulting_authority_epoch,
  });
  if (row?.["count"] !== 1) {
    throw new Error("authority cutover Domain Operation requires one exact receipt");
  }
}

function requireMatchingImportRestore(
  operation: OperationRow,
  contract: Readonly<ImportRestoreReceiptContract>,
): void {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_import_restores
    WHERE operation_id = :operation_id
      AND project_id = :project_id
      AND application_operation_id = :application_operation_id
      AND application_identity_hash = :application_identity_hash
      AND application_resulting_project_revision = :application_resulting_project_revision
      AND application_resulting_authority_epoch = :application_resulting_authority_epoch
      AND erased_lineage_hash = :erased_lineage_hash
      AND erased_lineage_json = :erased_lineage_json
      AND preview_id = :preview_id
      AND preview_hash = :preview_hash
      AND backup_id = :backup_id
      AND backup_sha256 = :backup_sha256
      AND backup_byte_size = :backup_byte_size
      AND backup_schema_version = :backup_schema_version
      AND backup_project_revision = :backup_project_revision
      AND backup_authority_epoch = :backup_authority_epoch
      AND difference_hash = :difference_hash
      AND consent_hash = :consent_hash
      AND verification_hash = :verification_hash
      AND restored_at = :restored_at
      AND resulting_project_revision = :resulting_project_revision
      AND resulting_authority_epoch = :resulting_authority_epoch
  `).get({
    ":operation_id": operation.operation_id,
    ":project_id": operation.project_id,
    ":application_operation_id": contract.applicationOperationId,
    ":application_identity_hash": contract.applicationIdentityHash,
    ":application_resulting_project_revision": contract.applicationResultingProjectRevision,
    ":application_resulting_authority_epoch": contract.applicationResultingAuthorityEpoch,
    ":erased_lineage_hash": contract.erasedLineageHash,
    ":erased_lineage_json": contract.erasedLineageJson,
    ":preview_id": contract.previewId,
    ":preview_hash": contract.previewHash,
    ":backup_id": contract.backupId,
    ":backup_sha256": contract.backupSha256,
    ":backup_byte_size": contract.backupByteSize,
    ":backup_schema_version": contract.backupSchemaVersion,
    ":backup_project_revision": contract.backupProjectRevision,
    ":backup_authority_epoch": contract.backupAuthorityEpoch,
    ":difference_hash": contract.differenceHash,
    ":consent_hash": contract.consentHash,
    ":verification_hash": contract.verificationHash,
    ":restored_at": operation.created_at,
    ":resulting_project_revision": operation.resulting_revision,
    ":resulting_authority_epoch": operation.resulting_authority_epoch,
  });
  if (row?.["count"] !== 1) {
    throw new Error("import restore Domain Operation requires one exact receipt");
  }
}

function requireMatchingImportForwardRepair(
  operation: OperationRow,
  plan: Readonly<LegacyImportForwardRepairPlan>,
): void {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_import_forward_repairs
    WHERE operation_id = :operation_id
      AND project_id = :project_id
      AND application_operation_id = :application_operation_id
      AND application_identity_hash = :application_identity_hash
      AND preview_id = :preview_id
      AND preview_hash = :preview_hash
      AND backup_id = :backup_id
      AND difference_hash = :difference_hash
      AND plan_schema_version = :plan_schema_version
      AND plan_hash = :plan_hash
      AND plan_json = :plan_json
      AND target_count = :target_count
      AND mutation_count = :mutation_count
      AND preserved_count = :preserved_count
      AND rejected_count = :rejected_count
      AND unresolved_count = :unresolved_count
      AND repaired_at = :repaired_at
      AND resulting_project_revision = :resulting_project_revision
      AND resulting_authority_epoch = :resulting_authority_epoch
  `).get({
    ":operation_id": operation.operation_id,
    ":project_id": operation.project_id,
    ":application_operation_id": plan.applicationOperationId,
    ":application_identity_hash": plan.applicationIdentityHash,
    ":preview_id": plan.previewId,
    ":preview_hash": plan.previewHash,
    ":backup_id": plan.backupId,
    ":difference_hash": plan.differenceHash,
    ":plan_schema_version": plan.planSchemaVersion,
    ":plan_hash": hashLegacyImportValue(plan as unknown as DomainJsonValue),
    ":plan_json": canonicalLegacyImportJson(plan as unknown as LegacyImportValue),
    ":target_count": plan.targetCount,
    ":mutation_count": plan.mutationCount,
    ":preserved_count": plan.preservedCount,
    ":rejected_count": plan.rejectedCount,
    ":unresolved_count": plan.unresolvedCount,
    ":repaired_at": operation.created_at,
    ":resulting_project_revision": operation.resulting_revision,
    ":resulting_authority_epoch": operation.resulting_authority_epoch,
  });
  if (row?.["count"] !== 1) {
    throw new Error("import Forward Repair Domain Operation requires one exact receipt");
  }
}

function staleAuthority(request: DomainOperationRequestIdentity, authority: AuthorityRow): never {
  if (authority.revision !== request.expectedRevision) {
    throw new GSDError(
      GSD_REVISION_CONFLICT,
      `stale project revision: expected ${request.expectedRevision}, current ${authority.revision}`,
    );
  }
  throw new GSDError(
    GSD_REVISION_CONFLICT,
    `stale authority epoch: expected ${request.expectedAuthorityEpoch}, current ${authority.authority_epoch}`,
  );
}

function runDomainOperationTransaction(fn: () => DomainOperationResult): DomainOperationResult {
  try {
    return immediateTransaction(fn);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new GSDError(
        GSD_REVISION_CONFLICT,
        "domain operation writer contention; retry the request",
        { cause: error },
      );
    }
    throw error;
  }
}

function executeDomainOperationCore(
  request: DomainOperationRequestIdentity,
  hash: string,
  importPreview: LegacyImportPreviewArtifact | null,
  authorityCutover: Readonly<AuthorityCutoverReceiptContract> | null,
  importRestore: Readonly<ImportRestoreReceiptContract> | null,
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
  preCommit: (() => void) | null = null,
  importForwardRepair: Readonly<LegacyImportForwardRepairPlan> | null = null,
): DomainOperationResult {
  const result = runDomainOperationTransaction((): DomainOperationResult => {
    const db = getDb();
    const authority = db.prepare(`
      SELECT project_id, revision, authority_epoch
      FROM project_authority WHERE singleton = 1
    `).get() as unknown as AuthorityRow | undefined;
    if (!authority) throw new Error("project authority is missing");
    requireNonNegativeSafeInteger(authority.revision, "stored project revision");
    requireNonNegativeSafeInteger(authority.authority_epoch, "stored authority epoch");

    const existing = db.prepare(`
      SELECT operation_id, project_id, operation_type, idempotency_key,
             expected_revision, resulting_revision,
             expected_authority_epoch, resulting_authority_epoch,
             actor_type, actor_id, source_transport, trace_id, turn_id, request_hash,
             created_at
      FROM workflow_operations
      WHERE project_id = :project_id AND idempotency_key = :idempotency_key
    `).get({
      ":project_id": authority.project_id,
      ":idempotency_key": request.idempotencyKey,
    }) as unknown as OperationRow | undefined;
    if (existing) {
      requireReplayMatch(existing, request, hash);
      if (importPreview) requireMatchingImportApplication(existing, importPreview);
      if (authorityCutover) requireMatchingAuthorityCutover(existing, authorityCutover);
      if (importRestore) requireMatchingImportRestore(existing, importRestore);
      if (importForwardRepair) requireMatchingImportForwardRepair(existing, importForwardRepair);
      preCommit?.();
      return loadReceipt(existing, "replayed");
    }

    if (
      authority.revision !== request.expectedRevision ||
      authority.authority_epoch !== request.expectedAuthorityEpoch
    ) {
      staleAuthority(request, authority);
    }

    const now = new Date().toISOString();
    const operationId = randomUUID();
    const resultingRevision = request.expectedRevision + 1;
    const resultingAuthorityEpoch = request.expectedAuthorityEpoch + (authorityCutover ? 1 : 0);
    const context = Object.freeze({
      operationId,
      projectId: authority.project_id,
      resultingRevision,
      resultingAuthorityEpoch,
    });

    db.prepare(`
      INSERT INTO workflow_operations (
        operation_id, project_id, operation_type, idempotency_key,
        expected_revision, resulting_revision,
        expected_authority_epoch, resulting_authority_epoch,
        actor_type, actor_id, source_transport, trace_id, turn_id,
        request_hash, created_at
      ) VALUES (
        :operation_id, :project_id, :operation_type, :idempotency_key,
        :expected_revision, :resulting_revision,
        :expected_authority_epoch, :resulting_authority_epoch,
        :actor_type, :actor_id, :source_transport, :trace_id, :turn_id,
        :request_hash, :created_at
      )
    `).run({
      ":operation_id": operationId,
      ":project_id": authority.project_id,
      ":operation_type": request.operationType,
      ":idempotency_key": request.idempotencyKey,
      ":expected_revision": request.expectedRevision,
      ":resulting_revision": resultingRevision,
      ":expected_authority_epoch": request.expectedAuthorityEpoch,
      ":resulting_authority_epoch": resultingAuthorityEpoch,
      ":actor_type": request.actorType,
      ":actor_id": request.actorId ?? null,
      ":source_transport": request.sourceTransport,
      ":trace_id": request.traceId ?? null,
      ":turn_id": request.turnId ?? null,
      ":request_hash": hash,
      ":created_at": now,
    });
    hitFault("after-operation", request.operationType);

    const mutation = mutate(context);
    const eventPayloads = validateMutation(mutation);
    const storedOperation = requireCommittedProvenance(
      loadOperation(operationId),
      request,
      hash,
      context,
      now,
    );
    hitFault("after-mutation", request.operationType);

    const eventIds: string[] = [];
    mutation.events.forEach((event, eventIndex) => {
      const eventId = randomUUID();
      const causedByEventId =
        event.causedByEventIndex === undefined ? null : eventIds[event.causedByEventIndex];
      db.prepare(`
        INSERT INTO workflow_domain_events (
          event_id, operation_id, event_index, project_id, project_revision,
          authority_epoch, event_type, entity_type, entity_id,
          caused_by_event_id, payload_json, created_at
        ) VALUES (
          :event_id, :operation_id, :event_index, :project_id, :project_revision,
          :authority_epoch, :event_type, :entity_type, :entity_id,
          :caused_by_event_id, :payload_json, :created_at
        )
      `).run({
        ":event_id": eventId,
        ":operation_id": operationId,
        ":event_index": eventIndex,
        ":project_id": authority.project_id,
        ":project_revision": resultingRevision,
        ":authority_epoch": resultingAuthorityEpoch,
        ":event_type": event.eventType,
        ":entity_type": event.entityType,
        ":entity_id": event.entityId,
        ":caused_by_event_id": causedByEventId,
        ":payload_json": eventPayloads[eventIndex],
        ":created_at": now,
      });
      eventIds.push(eventId);
    });
    hitFault("after-events", request.operationType);

    mutation.events.forEach((event, eventIndex) => {
      for (const destination of event.destinations) {
        db.prepare(`
          INSERT INTO workflow_outbox (event_id, destination, available_at)
          VALUES (:event_id, :destination, :available_at)
        `).run({
          ":event_id": eventIds[eventIndex],
          ":destination": destination,
          ":available_at": now,
        });
      }
    });
    hitFault("after-outbox", request.operationType);

    mutation.projections.forEach((projection, projectionIndex) => {
      const previous = db.prepare(`
        SELECT current.projection_work_id
        FROM workflow_projection_work current
        WHERE current.project_id = :project_id
          AND current.projection_key = :projection_key
          AND NOT EXISTS (
            SELECT 1 FROM workflow_projection_work successor
            WHERE successor.supersedes_projection_work_id = current.projection_work_id
          )
      `).get({
        ":project_id": authority.project_id,
        ":projection_key": projection.projectionKey,
      });
      db.prepare(`
        INSERT INTO workflow_projection_work (
          projection_work_id, project_id, projection_key, projection_kind,
          supersedes_projection_work_id, source_project_revision,
          source_authority_epoch, renderer_version, enqueue_operation_id,
          created_at, updated_at
        ) VALUES (
          :projection_work_id, :project_id, :projection_key, :projection_kind,
          :supersedes_projection_work_id, :source_project_revision,
          :source_authority_epoch, :renderer_version, :enqueue_operation_id,
          :created_at, :updated_at
        )
      `).run({
        ":projection_work_id": `${operationId}:${String(projectionIndex).padStart(4, "0")}`,
        ":project_id": authority.project_id,
        ":projection_key": projection.projectionKey,
        ":projection_kind": projection.projectionKind,
        ":supersedes_projection_work_id": previous?.["projection_work_id"] ?? null,
        ":source_project_revision": resultingRevision,
        ":source_authority_epoch": resultingAuthorityEpoch,
        ":renderer_version": projection.rendererVersion,
        ":enqueue_operation_id": operationId,
        ":created_at": now,
        ":updated_at": now,
      });
    });
    hitFault("after-projections", request.operationType);
    if (importPreview) requireMatchingImportApplication(storedOperation, importPreview);
    if (authorityCutover) requireMatchingAuthorityCutover(storedOperation, authorityCutover);
    if (importRestore) requireMatchingImportRestore(storedOperation, importRestore);
    if (importForwardRepair) requireMatchingImportForwardRepair(storedOperation, importForwardRepair);
    hitFault("before-cas", request.operationType);

    const update = db.prepare(`
      UPDATE project_authority
      SET revision = :resulting_revision,
          authority_epoch = :resulting_authority_epoch,
          updated_at = :updated_at
      WHERE singleton = 1
        AND project_id = :project_id
        AND revision = :expected_revision
        AND authority_epoch = :expected_authority_epoch
    `).run({
      ":resulting_revision": resultingRevision,
      ":resulting_authority_epoch": resultingAuthorityEpoch,
      ":updated_at": now,
      ":project_id": authority.project_id,
      ":expected_revision": request.expectedRevision,
      ":expected_authority_epoch": request.expectedAuthorityEpoch,
    });
    const changes =
      typeof (update as { changes?: unknown }).changes === "number"
        ? (update as { changes: number }).changes
        : 0;
    if (changes !== 1) {
      throw new GSDError(GSD_REVISION_CONFLICT, "domain operation authority CAS failed");
    }

    preCommit?.();
    return loadReceipt(storedOperation, "committed");
  });

  hitFault("after-commit", request.operationType);
  return result;
}

export function executeDomainOperation(
  request: DomainOperationRequest,
  /**
   * Compose deterministic typed writers only. Sibling tables must enforce the
   * supplied operation/revision context through their foreign keys; filesystem,
   * network, routing, retry, and error-swallowing behavior do not belong here.
  */
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult {
  const snapshot = snapshotDomainOperationRequest(request);
  validateRequestScalars(snapshot.identity);
  if (snapshot.identity.operationType === "import.apply") {
    throw new Error("import.apply requires executeImportDomainOperation");
  }
  if (snapshot.identity.operationType === "authority.cutover") {
    throw new Error("authority.cutover requires the typed authority cutover operation");
  }
  if (snapshot.identity.operationType === "import.restore") {
    throw new Error("import.restore requires the typed import restore operation");
  }
  if (snapshot.identity.operationType === "import.forward_repair") {
    throw new Error("import.forward_repair requires the typed Forward Repair operation");
  }
  if (isInTransaction()) {
    throw new Error("Domain Operation must own the outer transaction");
  }
  const stableRequest = {
    ...snapshot.identity,
    payload: snapshot.payload as DomainJsonValue,
  };
  return executeDomainOperationCore(
    snapshot.identity,
    requestHash(stableRequest),
    null,
    null,
    null,
    mutate,
  );
}

export function executeImportDomainOperation(
  request: ImportDomainOperationRequest,
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult {
  const snapshot = snapshotDomainOperationRequest(request);
  validateRequestScalars(snapshot.identity);
  if (snapshot.identity.operationType !== "import.apply") {
    throw new Error("executeImportDomainOperation requires operationType import.apply");
  }
  if (!isStrictLegacyImportData(snapshot.payload)) {
    throw new Error("import.apply Preview must contain strict data without accessors");
  }
  const preview = structuredClone(snapshot.payload);
  if (!isValidLegacyImportPreviewArtifact(preview)) {
    throw new Error("import.apply requires a valid sealed Preview artifact");
  }
  if (snapshot.identity.expectedRevision !== preview.preview.base_project_revision) {
    throw new Error("import.apply expectedRevision must match the sealed Preview base revision");
  }
  if (snapshot.identity.expectedAuthorityEpoch !== preview.preview.base_authority_epoch) {
    throw new Error("import.apply expectedAuthorityEpoch must match the sealed Preview base Authority Epoch");
  }
  if (isInTransaction()) {
    throw new Error("Domain Operation must own the outer transaction");
  }
  return executeDomainOperationCore(snapshot.identity, preview.preview_hash, preview, null, null, mutate);
}

/**
 * Private epoch-advancing seam for the strict project-authority cutover
 * aggregate. Public callers must use cutoverProjectAuthority, which validates
 * current Application evidence, Consent, coordination, and the durable receipt.
 */
export function _executeAuthorityCutoverDomainOperation(
  request: AuthorityCutoverDomainOperationRequest,
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult {
  const snapshot = snapshotDomainOperationRequest(request);
  validateRequestScalars(snapshot.identity);
  if (snapshot.identity.operationType !== "authority.cutover") {
    throw new Error("typed authority cutover requires operationType authority.cutover");
  }
  if (snapshot.identity.expectedAuthorityEpoch === Number.MAX_SAFE_INTEGER) {
    throw new Error("expectedAuthorityEpoch requires safe integer increment headroom");
  }
  if (isInTransaction()) {
    throw new Error("Domain Operation must own the outer transaction");
  }
  const stableRequest = {
    ...snapshot.identity,
    payload: snapshot.payload as DomainJsonValue,
  };
  const receipt = snapshotAuthorityCutoverReceiptContract(snapshot.payload);
  return executeDomainOperationCore(
    snapshot.identity,
    requestHash(stableRequest, true),
    null,
    receipt,
    null,
    mutate,
  );
}

/**
 * Private receipt-bound seam for live restore. Public callers must first
 * replace and verify the database file, then use this seam to record the exact
 * erased Application lineage in the restored database.
 */
export function _executeImportRestoreDomainOperation(
  capability: DatabaseReplacementReceiptCapability,
  request: ImportRestoreDomainOperationRequest,
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult {
  const snapshot = snapshotDomainOperationRequest(request);
  validateRequestScalars(snapshot.identity);
  if (snapshot.identity.operationType !== "import.restore") {
    throw new Error("typed import restore requires operationType import.restore");
  }
  const receipt = snapshotImportRestoreReceiptContract(snapshot.payload);
  if (
    snapshot.identity.expectedRevision !== receipt.backupProjectRevision
    || snapshot.identity.expectedAuthorityEpoch !== receipt.backupAuthorityEpoch
  ) {
    throw new Error("import.restore authority fence must match the restored backup");
  }
  if (isInTransaction()) {
    throw new Error("Domain Operation must own the outer transaction");
  }
  const stableRequest = {
    ...snapshot.identity,
    payload: receipt as unknown as DomainJsonValue,
  };
  return withDatabaseReplacementWriteBypass(
    capability,
    () => executeDomainOperationCore(
      snapshot.identity,
      requestHash(stableRequest),
      null,
      null,
      receipt,
      mutate,
      () => assertDatabaseReplacementReceiptIntent(capability),
    ),
  );
}

/** Private transaction seam for the strict Import Forward Repair aggregate. */
export function _executeImportForwardRepairDomainOperation(
  request: ImportForwardRepairDomainOperationRequest,
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation,
): DomainOperationResult {
  const snapshot = snapshotDomainOperationRequest(request);
  validateRequestScalars(snapshot.identity);
  if (snapshot.identity.operationType !== "import.forward_repair") {
    throw new Error("typed Forward Repair requires operationType import.forward_repair");
  }
  if (!isStrictLegacyImportData(snapshot.payload)) {
    throw new Error("import.forward_repair plan must contain strict data without accessors");
  }
  if (isInTransaction()) {
    throw new Error("Domain Operation must own the outer transaction");
  }
  const stableRequest = {
    ...snapshot.identity,
    payload: snapshot.payload as DomainJsonValue,
  };
  const plan = structuredClone(snapshot.payload) as LegacyImportForwardRepairPlan;
  return executeDomainOperationCore(
    snapshot.identity,
    requestHash(stableRequest),
    null,
    null,
    null,
    mutate,
    null,
    plan,
  );
}
