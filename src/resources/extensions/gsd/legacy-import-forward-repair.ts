// Project/App: gsd-pi
// File Purpose: Public inspection and application boundary for legacy Import Forward Repair.

import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  isValidLegacyImportVerifiedBackup,
  verifyLegacyImportBackupArtifact,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import { inspectLegacyImportApplicationEvidence } from "./legacy-import-application-evidence.js";
import {
  compileLegacyImportForwardRepairPlan,
  type LegacyImportForwardRepairChoice,
  type LegacyImportForwardRepairGoal,
  type LegacyImportForwardRepairPlan,
} from "./legacy-import-forward-repair-plan.js";
import {
  captureCurrentLegacyImportBaseSnapshot,
  captureLegacyImportBaseSnapshot,
  createLegacyImportBaseSnapshotSource,
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  isStrictLegacyImportData,
} from "./legacy-import-preview.js";
import { inspectSqliteReadOnlySnapshot } from "./sqlite-readonly.js";
import {
  _executeImportForwardRepairDomainOperation,
  type DomainJsonValue,
  type ImportForwardRepairDomainOperationRequest,
} from "./db/domain-operation.js";
import { getDb, readTransaction } from "./db/engine.js";
import {
  applyImportForwardRepairPlan,
  insertImportForwardRepairReceipt,
} from "./db/writers/authority-recovery.js";

export interface LegacyImportForwardRepairInspectionInput {
  readonly applicationIdentityHash: string;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
  readonly choices?: readonly Readonly<LegacyImportForwardRepairChoice>[];
}

export interface LegacyImportForwardRepairInput extends LegacyImportForwardRepairInspectionInput {
  readonly invocation: Readonly<ExecutionInvocation>;
  readonly plan: Readonly<LegacyImportForwardRepairPlan>;
}

export interface LegacyImportForwardRepairResult {
  readonly status: "committed" | "replayed";
  readonly operationId: string;
  readonly projectId: string;
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly planHash: string;
  readonly differenceHash: string;
  readonly targetCount: number;
  readonly mutationCount: number;
  readonly preservedCount: number;
  readonly rejectedCount: number;
  readonly resultingRevision: number;
  readonly resultingAuthorityEpoch: number;
  readonly repairedAt: string;
  readonly eventIds: readonly string[];
  readonly outboxIds: readonly number[];
  readonly projectionWorkIds: readonly string[];
}

export class LegacyImportForwardRepairError extends Error {
  readonly stage: "contract" | "base" | "plan" | "choice" | "transaction" | "receipt";
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    stage: LegacyImportForwardRepairError["stage"],
    code: string,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "LegacyImportForwardRepairError";
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
  }
}

interface InspectionEvidence {
  readonly application: ReturnType<typeof inspectLegacyImportApplicationEvidence>;
  readonly backup: LegacyImportVerifiedBackup;
  readonly backupBase: LegacyImportBaseSnapshot;
  readonly choices: readonly Readonly<LegacyImportForwardRepairChoice>[];
}

function fail(
  stage: LegacyImportForwardRepairError["stage"],
  code: string,
  message: string,
  retryable = false,
): never {
  throw new LegacyImportForwardRepairError(stage, code, message, retryable);
}

function snapshotInspectionInput(
  value: Readonly<LegacyImportForwardRepairInspectionInput>,
): LegacyImportForwardRepairInspectionInput {
  if (!isStrictLegacyImportData(value)) {
    fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair input must be strict data");
  }
  let input: LegacyImportForwardRepairInspectionInput;
  try {
    input = structuredClone(value);
  } catch {
    fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair input could not be detached");
  }
  if (
    !["applicationIdentityHash\0backup", "applicationIdentityHash\0backup\0choices"]
      .includes(Object.keys(input).sort().join("\0"))
    || !/^sha256:[0-9a-f]{64}$/.test(input.applicationIdentityHash)
    || !isValidLegacyImportVerifiedBackup(input.backup)
    || !validChoices(input.choices)
  ) fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair input is invalid");
  return input;
}

function validChoices(value: unknown): value is readonly LegacyImportForwardRepairChoice[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const indexes = new Set<number>();
  for (const choice of value) {
    if (
      choice === null
      || typeof choice !== "object"
      || Array.isArray(choice)
      || Object.keys(choice).sort().join("\0") !== "decision\0instructionIndex\0reviewHash\0targetKey\0targetKind"
    ) return false;
    const record = choice as Record<string, unknown>;
    const index = record["instructionIndex"];
    if (
      !Number.isSafeInteger(index)
      || Number(index) < 0
      || indexes.has(Number(index))
      || typeof record["targetKind"] !== "string"
      || String(record["targetKind"]).length === 0
      || typeof record["targetKey"] !== "string"
      || String(record["targetKey"]).length === 0
      || typeof record["reviewHash"] !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(String(record["reviewHash"]))
      || (record["decision"] !== "preserve-later" && record["decision"] !== "restore-backup")
    ) return false;
    indexes.add(Number(index));
  }
  return true;
}

export function replayLegacyImportForwardRepair(
  input: Readonly<LegacyImportForwardRepairInspectionInput>,
): LegacyImportForwardRepairResult {
  const evidence = inspectionEvidence(input);
  const rows = readTransaction(() => getDb().prepare(`SELECT operation_id, plan_json
    FROM workflow_import_forward_repairs WHERE application_identity_hash = :identity`).all({
    ":identity": evidence.application.applicationIdentityHash,
  }));
  if (rows.length !== 1 || typeof rows[0]?.["operation_id"] !== "string"
    || typeof rows[0]?.["plan_json"] !== "string") {
    fail("receipt", "LEGACY_IMPORT_FORWARD_REPAIR_RECEIPT_INVALID", "Forward Repair terminal receipt is missing");
  }
  let plan: unknown;
  try { plan = JSON.parse(String(rows[0]!["plan_json"])); } catch { plan = null; }
  if (!isStrictLegacyImportData(plan)) {
    fail("receipt", "LEGACY_IMPORT_FORWARD_REPAIR_RECEIPT_INVALID", "Forward Repair terminal plan is invalid");
  }
  return repairResult(String(rows[0]!["operation_id"]), "replayed", plan as unknown as LegacyImportForwardRepairPlan);
}

function applicationOperationId(identityHash: string): string {
  const rows = readTransaction(() => getDb().prepare(`
    SELECT application.operation_id
    FROM workflow_import_applications application
    JOIN workflow_domain_events event
      ON event.operation_id = application.operation_id
     AND event.event_index = 0
     AND event.event_type = 'legacy-import.applied'
    WHERE json_extract(event.payload_json, '$.applicationIdentityHash') = :identity_hash
    ORDER BY application.operation_id
  `).all({ ":identity_hash": identityHash }));
  if (rows.length !== 1 || typeof rows[0]?.["operation_id"] !== "string") {
    fail("base", "LEGACY_IMPORT_FORWARD_REPAIR_APPLICATION_INVALID", "Forward Repair requires one exact retained Import Application");
  }
  return String(rows[0]!["operation_id"]);
}

function captureBackupBase(backup: LegacyImportVerifiedBackup): LegacyImportBaseSnapshot {
  try {
    return inspectSqliteReadOnlySnapshot(backup.backup_ref, (db) => captureLegacyImportBaseSnapshot({
      readTransaction: (fn) => fn(),
      source: createLegacyImportBaseSnapshotSource(db),
    }));
  } catch {
    fail("base", "LEGACY_IMPORT_FORWARD_REPAIR_BACKUP_INVALID", "Forward Repair could not capture the verified backup base");
  }
}

function inspectionEvidence(
  input: Readonly<LegacyImportForwardRepairInspectionInput>,
): InspectionEvidence {
  const snapshot = snapshotInspectionInput(input);
  const application = inspectLegacyImportApplicationEvidence(
    applicationOperationId(snapshot.applicationIdentityHash),
  );
  const backup = snapshot.backup;
  if (
    application.applicationIdentityHash !== snapshot.applicationIdentityHash
    || application.backupId !== backup.backup_id
    || application.preview.preview.preview_id !== backup.preview_id
    || application.preview.preview_hash !== backup.preview_hash
    || application.backupRef !== backup.backup_ref
    || application.backupSha256 !== backup.backup_sha256
    || application.backupByteSize !== backup.backup_byte_size
    || application.backupSchemaVersion !== backup.backup_database_schema_version
    || application.backupProjectRevision !== backup.base_project_revision
    || application.backupAuthorityEpoch !== backup.base_authority_epoch
  ) fail("base", "LEGACY_IMPORT_FORWARD_REPAIR_BACKUP_MISMATCH", "Forward Repair backup does not match its Import Application");
  const backupBase = captureBackupBase(backup);
  try {
    verifyLegacyImportBackupArtifact({ backup, preview: application.preview, base: backupBase });
  } catch {
    fail("base", "LEGACY_IMPORT_FORWARD_REPAIR_BACKUP_INVALID", "Forward Repair backup verification failed");
  }
  return { application, backup, backupBase, choices: snapshot.choices ?? [] };
}

function compileFromEvidence(
  evidence: InspectionEvidence,
  currentBase: LegacyImportBaseSnapshot,
  choices: readonly Readonly<LegacyImportForwardRepairChoice>[] = [],
  goal: LegacyImportForwardRepairGoal = "revert",
): LegacyImportForwardRepairPlan {
  const { application, backup, backupBase } = evidence;
  if (
    currentBase.authority.project_id !== application.projectId
    || currentBase.authority.project_root_realpath !== application.projectRootRealpath
  ) fail("plan", "LEGACY_IMPORT_FORWARD_REPAIR_EVIDENCE_MISMATCH", "Forward Repair current authority does not match its Import Application evidence");
  if (
    currentBase.authority.revision <= application.resultingProjectRevision
      && currentBase.authority.authority_epoch <= application.resultingAuthorityEpoch
  ) fail("plan", "LEGACY_IMPORT_FORWARD_REPAIR_NOT_REQUIRED", "Forward Repair requires accepted work after the Import Application");
  try {
    return compileLegacyImportForwardRepairPlan({
      applicationOperationId: application.operationId,
      applicationIdentityHash: application.applicationIdentityHash,
      applicationRelevantRowsHash: application.applicationRelevantRowsHash,
      previewId: application.preview.preview.preview_id,
      previewHash: application.preview.preview_hash,
      backupId: backup.backup_id,
      applicationPlan: application.plan,
      backupBase,
      currentBase,
      choices,
      goal,
    });
  } catch (error) {
    if (error instanceof LegacyImportForwardRepairError) throw error;
    if (error instanceof Error && error.message === "Forward Repair choice does not match its reviewed target") {
      fail("plan", "LEGACY_IMPORT_FORWARD_REPAIR_PLAN_INVALID", error.message);
    }
    fail("plan", "LEGACY_IMPORT_FORWARD_REPAIR_PLAN_INVALID", "Forward Repair plan could not be compiled");
  }
}

export function inspectLegacyImportForwardRepair(
  input: Readonly<LegacyImportForwardRepairInspectionInput>,
  goal: LegacyImportForwardRepairGoal = "revert",
): LegacyImportForwardRepairPlan {
  const evidence = inspectionEvidence(input);
  return compileFromEvidence(evidence, captureCurrentLegacyImportBaseSnapshot(), evidence.choices, goal);
}

/**
 * The goal a submitted plan was compiled with. Plans compiled before goals
 * existed have no field and are revert plans; anything else must be exact —
 * the recompiled plan hash comparison binds the goal to the receipt.
 */
function repairPlanGoal(plan: Readonly<LegacyImportForwardRepairPlan>): LegacyImportForwardRepairGoal {
  const goal = plan.goal ?? "revert";
  if (goal !== "revert" && goal !== "retain") {
    fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair plan goal is invalid");
  }
  return goal;
}

function snapshotApplyInput(value: Readonly<LegacyImportForwardRepairInput>): LegacyImportForwardRepairInput {
  if (!isStrictLegacyImportData(value)) {
    fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair application input must be strict data");
  }
  let input: LegacyImportForwardRepairInput;
  try { input = structuredClone(value); } catch {
    fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair application input could not be detached");
  }
  if (
    !["applicationIdentityHash\0backup\0invocation\0plan", "applicationIdentityHash\0backup\0choices\0invocation\0plan"]
      .includes(Object.keys(input).sort().join("\0"))
    || !validChoices(input.choices)
  ) {
    fail("contract", "LEGACY_IMPORT_FORWARD_REPAIR_CONTRACT_INVALID", "Forward Repair application input is invalid");
  }
  return input;
}

function repairResult(
  operationId: string,
  status: "committed" | "replayed",
  expectedPlan: Readonly<LegacyImportForwardRepairPlan>,
): LegacyImportForwardRepairResult {
  const row = getDb().prepare(`
    SELECT receipt.*, operation.created_at
    FROM workflow_import_forward_repairs receipt
    JOIN workflow_operations operation USING (operation_id)
    WHERE receipt.operation_id = :operation_id
  `).get({ ":operation_id": operationId });
  if (!row) fail("receipt", "LEGACY_IMPORT_FORWARD_REPAIR_RECEIPT_INVALID", "Forward Repair receipt is missing");
  const events = getDb().prepare(`SELECT * FROM workflow_domain_events
    WHERE operation_id = :operation_id ORDER BY event_index`).all({ ":operation_id": operationId });
  const outbox = getDb().prepare(`SELECT * FROM workflow_outbox WHERE event_id IN (
    SELECT event_id FROM workflow_domain_events WHERE operation_id = :operation_id
  ) ORDER BY outbox_id`).all({ ":operation_id": operationId });
  const projections = getDb().prepare(`SELECT * FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id ORDER BY projection_work_id`).all({ ":operation_id": operationId });
  const planJson = canonicalLegacyImportJson(expectedPlan);
  const planHash = hashLegacyImportValue(expectedPlan);
  const event = events[0];
  const delivery = outbox[0];
  const projection = projections[0];
  if (
    row["application_operation_id"] !== expectedPlan.applicationOperationId
    || row["application_identity_hash"] !== expectedPlan.applicationIdentityHash
    || row["preview_id"] !== expectedPlan.previewId
    || row["preview_hash"] !== expectedPlan.previewHash
    || row["backup_id"] !== expectedPlan.backupId
    || row["difference_hash"] !== expectedPlan.differenceHash
    || row["plan_schema_version"] !== expectedPlan.planSchemaVersion
    || row["plan_hash"] !== planHash
    || row["plan_json"] !== planJson
    || row["target_count"] !== expectedPlan.targetCount
    || row["mutation_count"] !== expectedPlan.mutationCount
    || row["preserved_count"] !== expectedPlan.preservedCount
    || row["rejected_count"] !== expectedPlan.rejectedCount
    || row["unresolved_count"] !== 0
    || row["resulting_project_revision"] !== expectedPlan.expectedProjectRevision + 1
    || row["resulting_authority_epoch"] !== expectedPlan.expectedAuthorityEpoch
    || row["repaired_at"] !== row["created_at"]
    || events.length !== 1
    || event?.["event_index"] !== 0
    || event["project_id"] !== row["project_id"]
    || event["project_revision"] !== row["resulting_project_revision"]
    || event["authority_epoch"] !== row["resulting_authority_epoch"]
    || event["event_type"] !== "legacy-import.forward-repaired"
    || event["entity_type"] !== "legacy-import"
    || event["entity_id"] !== expectedPlan.previewId
    || event["caused_by_event_id"] !== null
    || event["payload_json"] !== planJson
    || event["created_at"] !== row["repaired_at"]
    || outbox.length !== 1
    || delivery?.["event_id"] !== event["event_id"]
    || delivery["destination"] !== "projection"
    || delivery["available_at"] !== row["repaired_at"]
    || projections.length !== 1
    || projection?.["projection_work_id"] !== `${operationId}:0000`
    || projection["project_id"] !== row["project_id"]
    || projection["projection_key"] !== "legacy-import/forward-repair"
    || projection["projection_kind"] !== "markdown"
    || projection["source_project_revision"] !== row["resulting_project_revision"]
    || projection["source_authority_epoch"] !== row["resulting_authority_epoch"]
    || projection["renderer_version"] !== "v1"
    || projection["enqueue_operation_id"] !== operationId
    || projection["created_at"] !== row["repaired_at"]
  ) fail("receipt", "LEGACY_IMPORT_FORWARD_REPAIR_RECEIPT_INVALID", "Forward Repair receipt is inconsistent");
  return Object.freeze({
    status,
    operationId,
    projectId: String(row["project_id"]),
    applicationOperationId: String(row["application_operation_id"]),
    applicationIdentityHash: String(row["application_identity_hash"]),
    planHash: String(row["plan_hash"]),
    differenceHash: String(row["difference_hash"]),
    targetCount: Number(row["target_count"]),
    mutationCount: Number(row["mutation_count"]),
    preservedCount: Number(row["preserved_count"]),
    rejectedCount: Number(row["rejected_count"]),
    resultingRevision: Number(row["resulting_project_revision"]),
    resultingAuthorityEpoch: Number(row["resulting_authority_epoch"]),
    repairedAt: String(row["repaired_at"]),
    eventIds: Object.freeze(events.map((entry) => String(entry["event_id"]))),
    outboxIds: Object.freeze(outbox.map((entry) => Number(entry["outbox_id"]))),
    projectionWorkIds: Object.freeze(projections.map((entry) => String(entry["projection_work_id"]))),
  });
}

function operationRequest(
  input: Readonly<LegacyImportForwardRepairInput>,
): ImportForwardRepairDomainOperationRequest {
  const invocation = input.invocation;
  return {
    operationType: "import.forward_repair",
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: input.plan.expectedProjectRevision,
    expectedAuthorityEpoch: input.plan.expectedAuthorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: input.plan,
  };
}

function replayRepair(
  input: Readonly<LegacyImportForwardRepairInput>,
): LegacyImportForwardRepairResult | null {
  const exists = readTransaction(() => getDb().prepare(`
    SELECT 1
    FROM workflow_operations
    WHERE operation_type = 'import.forward_repair'
      AND idempotency_key = :idempotency_key
  `).get({ ":idempotency_key": input.invocation.idempotencyKey }));
  if (!exists) return null;
  const operation = _executeImportForwardRepairDomainOperation(operationRequest(input), () => {
    throw new Error("Forward Repair replay unexpectedly entered its mutation boundary");
  });
  return repairResult(operation.operationId, "replayed", input.plan);
}

export function applyLegacyImportForwardRepair(
  value: Readonly<LegacyImportForwardRepairInput>,
): LegacyImportForwardRepairResult {
  const input = snapshotApplyInput(value);
  const replayed = replayRepair(input);
  if (replayed) return replayed;
  const goal = repairPlanGoal(input.plan);
  const evidence = inspectionEvidence({
    applicationIdentityHash: input.applicationIdentityHash,
    backup: input.backup,
  });
  const expectedPlan = compileFromEvidence(evidence, captureCurrentLegacyImportBaseSnapshot(), input.choices, goal);
  const expectedHash = hashLegacyImportValue(expectedPlan as unknown as DomainJsonValue);
  if (hashLegacyImportValue(input.plan as unknown as DomainJsonValue) !== expectedHash) {
    fail("plan", "LEGACY_IMPORT_FORWARD_REPAIR_PLAN_CHANGED", "Forward Repair plan is stale or changed", true);
  }
  if (expectedPlan.unresolvedCount !== 0) {
    fail("choice", "LEGACY_IMPORT_FORWARD_REPAIR_CHOICE_REQUIRED", "Forward Repair has unresolved target choices");
  }
  let receiptPlanHash: string = expectedHash;
  const operation = _executeImportForwardRepairDomainOperation(operationRequest(input), (context) => {
    const currentPlan = compileFromEvidence(evidence, captureCurrentLegacyImportBaseSnapshot(), input.choices, goal);
    if (hashLegacyImportValue(currentPlan as unknown as DomainJsonValue) !== expectedHash) {
      fail("plan", "LEGACY_IMPORT_FORWARD_REPAIR_PLAN_CHANGED", "Forward Repair plan changed before mutation", true);
    }
    applyImportForwardRepairPlan(context, currentPlan);
    receiptPlanHash = insertImportForwardRepairReceipt(context, currentPlan).planHash;
    return {
      events: [{
        eventType: "legacy-import.forward-repaired",
        entityType: "legacy-import",
        entityId: currentPlan.previewId,
        payload: currentPlan as unknown as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "legacy-import/forward-repair",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const result = repairResult(operation.operationId, operation.status, expectedPlan);
  if (
    result.planHash !== receiptPlanHash
    || result.planHash !== expectedHash
    || result.eventIds.length !== 1
    || result.outboxIds.length !== 1
    || result.projectionWorkIds.length !== 1
  ) fail("receipt", "LEGACY_IMPORT_FORWARD_REPAIR_RECEIPT_INVALID", "Forward Repair receipt is inconsistent");
  return result;
}
