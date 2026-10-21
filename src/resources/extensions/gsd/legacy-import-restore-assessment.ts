// Project/App: gsd-pi
// File Purpose: Pure restore-window assessment after one explicit legacy Import Application.

import { deepFreeze } from "./legacy-import-utils.js";

import {
  isValidLegacyImportVerifiedBackup,
  verifyLegacyImportBackupArtifact,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import {
  inspectLegacyImportApplicationEvidence,
  LegacyImportApplicationEvidenceError,
  type LegacyImportApplicationEvidence,
} from "./legacy-import-application-evidence.js";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  isStrictLegacyImportData,
} from "./legacy-import-preview.js";
import {
  captureCurrentLegacyImportBaseSnapshot,
  captureLegacyImportBaseSnapshot,
  createLegacyImportBaseSnapshotSource,
  type LegacyImportBaseRow,
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import { getDb, readTransaction, SCHEMA_VERSION } from "./db/engine.js";
import { inspectSqliteReadOnlySnapshot } from "./sqlite-readonly.js";

export const LEGACY_IMPORT_RESTORE_ASSESSMENT_SCHEMA_VERSION = 1 as const;
export const LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION = 1 as const;

export type LegacyImportRestoreAssessmentDecision =
  | "transaction-rollback-only"
  | "restore-consent-required"
  | "restore-eligible"
  | "forward-repair-required"
  | "already-restored"
  | "temporarily-unavailable"
  | "refused";

export type LegacyImportRestoreAssessmentStage =
  | "application"
  | "authority"
  | "backup"
  | "coordination"
  | "route"
  | "consent";

export interface LegacyImportRestoreAssessmentConsent {
  readonly consentSchemaVersion:
    typeof LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION;
  readonly decision: "proceed";
  readonly destructiveDatabaseRestore: true;
  readonly evidenceHash: string;
}

export interface LegacyImportRestoreAssessmentInput {
  readonly applicationIdentityHash: string;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
  readonly consent?: Readonly<LegacyImportRestoreAssessmentConsent>;
}

export interface LegacyImportRestoreDifference {
  readonly createdCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  readonly unchangedCount: number;
  readonly differenceHash: string;
}

export interface LegacyImportRestoreAssessmentFacts {
  readonly expectedDatabaseSchemaVersion: number;
  readonly observedDatabaseSchemaVersion: number;
  readonly projectId: string;
  readonly observedProjectId: string;
  readonly expectedProjectRootRealpath: string;
  readonly observedProjectRootRealpath: string;
  readonly applicationOperationId: string | null;
  readonly applicationResultingProjectRevision: number | null;
  readonly applicationResultingAuthorityEpoch: number | null;
  readonly expectedRelevantRowsHash: string | null;
  readonly observedRelevantRowsHash: string | null;
  readonly expectedHeadOperationId: string | null;
  readonly observedHeadOperationId: string | null;
  readonly currentProjectRevision: number;
  readonly currentAuthorityEpoch: number;
  readonly coordination: Readonly<LegacyImportRestoreCoordinationCounts> | null;
  readonly backupVerified: boolean;
  readonly consentStatus: "missing" | "stale" | "matched";
  readonly backupId: string;
  readonly previewId: string;
  readonly previewHash: string;
  readonly difference: Readonly<LegacyImportRestoreDifference> | null;
}

export interface LegacyImportRestoreRecommendation {
  readonly recommendedOptionId: string;
  readonly recommendationText: string;
  readonly recommendationRationale: string;
  readonly question: string | null;
}

export interface LegacyImportRestoreAssessment {
  readonly assessmentSchemaVersion: typeof LEGACY_IMPORT_RESTORE_ASSESSMENT_SCHEMA_VERSION;
  readonly decision: LegacyImportRestoreAssessmentDecision;
  readonly stage: LegacyImportRestoreAssessmentStage;
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly evidenceHash: string;
  readonly facts: Readonly<LegacyImportRestoreAssessmentFacts>;
  readonly recommendation: Readonly<LegacyImportRestoreRecommendation>;
}

export class LegacyImportRestoreAssessmentError extends Error {
  readonly code = "LEGACY_IMPORT_RESTORE_ASSESSMENT_CONTRACT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "LegacyImportRestoreAssessmentError";
  }
}

interface AssessmentInputSnapshot {
  applicationIdentityHash: string;
  backup: LegacyImportVerifiedBackup;
  consent: LegacyImportRestoreAssessmentConsent | null;
}

export interface LegacyImportRestoreCoordinationCounts {
  activeWorkers: number;
  heldLeases: number;
  activeDispatches: number;
  activeAttempts: number;
}

interface AssessmentState {
  base: LegacyImportBaseSnapshot;
  headOperationId: string | null;
  headOperationType: string | null;
  laterOperationCount: number;
  cutoverCount: number;
  coordination: LegacyImportRestoreCoordinationCounts;
}

interface TerminalReceipt {
  route: "restore" | "forward-repair";
  operationId: string;
  applicationOperationId: string;
  projectId: string;
  backupId: string;
  previewId: string;
  previewHash: string;
  backupSha256: string | null;
  backupByteSize: number | null;
  backupSchemaVersion: number | null;
  backupProjectRevision: number | null;
  backupAuthorityEpoch: number | null;
}

type RestoreAssessmentBoundaryPoint = "after-initial-state" | "after-backup-verification";
type RestoreAssessmentBoundaryHook = (point: RestoreAssessmentBoundaryPoint) => void;

let restoreAssessmentBoundaryHookForTest: RestoreAssessmentBoundaryHook | null = null;

export function _setLegacyImportRestoreAssessmentBoundaryForTest(
  hook: RestoreAssessmentBoundaryHook | null,
): void {
  restoreAssessmentBoundaryHookForTest = hook;
}

function reachBoundary(point: RestoreAssessmentBoundaryPoint): void {
  restoreAssessmentBoundaryHookForTest?.(point);
}

function contractFail(message: string): never {
  throw new LegacyImportRestoreAssessmentError(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return required.every((key) => Object.hasOwn(descriptors, key))
    && keys.every((key) => (
      (required.includes(key) || optional.includes(key))
      && Object.hasOwn(descriptors[key] ?? {}, "value")
      && descriptors[key]?.enumerable === true
    ));
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    contractFail(`${field} must be one canonical SHA-256 digest`);
  }
  return value;
}

function normalizeConsent(value: unknown): LegacyImportRestoreAssessmentConsent | null {
  if (value === undefined) return null;
  if (!hasExactDataKeys(value, [
    "consentSchemaVersion",
    "decision",
    "destructiveDatabaseRestore",
    "evidenceHash",
  ])) {
    contractFail("restore Consent does not satisfy the exact v1 contract");
  }
  if (
    value["consentSchemaVersion"] !== LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION
    || value["decision"] !== "proceed"
    || value["destructiveDatabaseRestore"] !== true
  ) {
    contractFail("restore Consent requires an explicit v1 destructive proceed decision");
  }
  return {
    consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
    decision: "proceed",
    destructiveDatabaseRestore: true,
    evidenceHash: requireHash(value["evidenceHash"], "consent.evidenceHash"),
  };
}

function snapshotInput(value: unknown): AssessmentInputSnapshot {
  if (!hasExactDataKeys(value, ["applicationIdentityHash", "backup"], ["consent"])) {
    contractFail("restore assessment input does not satisfy the exact v1 contract");
  }
  if (!isStrictLegacyImportData(value)) {
    contractFail("restore assessment input must contain acyclic strict data properties");
  }
  let detached: Record<string, unknown>;
  try {
    detached = structuredClone(value);
  } catch {
    contractFail("restore assessment input must be detached strict data");
  }
  if (!isValidLegacyImportVerifiedBackup(detached["backup"])) {
    contractFail("backup must satisfy the complete self-identical verified v1 contract");
  }
  return deepFreeze({
    applicationIdentityHash: requireHash(
      detached["applicationIdentityHash"],
      "applicationIdentityHash",
    ),
    backup: detached["backup"],
    consent: normalizeConsent(detached["consent"]),
  });
}

function terminalReceipt(identityHash: string): TerminalReceipt | null {
  return readTransaction(() => {
    const rows = getDb().prepare(`
      SELECT 'restore' AS route, receipt.operation_id, receipt.application_operation_id,
             receipt.project_id, receipt.backup_id, receipt.preview_id, receipt.preview_hash,
             receipt.backup_sha256, receipt.backup_byte_size, receipt.backup_schema_version,
             receipt.backup_project_revision, receipt.backup_authority_epoch,
             receipt.application_resulting_project_revision,
             receipt.application_resulting_authority_epoch,
             receipt.erased_lineage_hash, receipt.erased_lineage_json,
             receipt.difference_hash, receipt.consent_hash, receipt.verification_hash,
             NULL AS plan_hash, NULL AS plan_json,
             NULL AS target_count, NULL AS mutation_count,
             NULL AS preserved_count, NULL AS rejected_count,
             NULL AS unresolved_count,
             receipt.restored_at AS terminal_at,
             receipt.resulting_project_revision, receipt.resulting_authority_epoch,
             operation.operation_type, operation.expected_revision,
             operation.resulting_revision AS operation_resulting_revision,
             operation.expected_authority_epoch,
             operation.resulting_authority_epoch AS operation_resulting_authority_epoch,
             operation.created_at,
             authority.revision AS current_revision,
             authority.authority_epoch AS current_authority_epoch
      FROM workflow_import_restores receipt
      JOIN workflow_operations operation USING (operation_id)
      JOIN project_authority authority ON authority.project_id = receipt.project_id
      WHERE receipt.application_identity_hash = :application_identity_hash
      UNION ALL
      SELECT 'forward-repair' AS route, receipt.operation_id, receipt.application_operation_id,
             receipt.project_id, receipt.backup_id, receipt.preview_id, receipt.preview_hash,
             NULL AS backup_sha256, NULL AS backup_byte_size,
             NULL AS backup_schema_version, NULL AS backup_project_revision,
             NULL AS backup_authority_epoch,
             NULL AS application_resulting_project_revision,
             NULL AS application_resulting_authority_epoch,
             NULL AS erased_lineage_hash, NULL AS erased_lineage_json,
             receipt.difference_hash, NULL AS consent_hash, NULL AS verification_hash,
             receipt.plan_hash, receipt.plan_json, receipt.target_count, receipt.mutation_count,
             receipt.preserved_count, receipt.rejected_count, receipt.unresolved_count,
             receipt.repaired_at AS terminal_at,
             receipt.resulting_project_revision, receipt.resulting_authority_epoch,
             operation.operation_type, operation.expected_revision,
             operation.resulting_revision AS operation_resulting_revision,
             operation.expected_authority_epoch,
             operation.resulting_authority_epoch AS operation_resulting_authority_epoch,
             operation.created_at,
             authority.revision AS current_revision,
             authority.authority_epoch AS current_authority_epoch
      FROM workflow_import_forward_repairs receipt
      JOIN workflow_operations operation USING (operation_id)
      JOIN project_authority authority ON authority.project_id = receipt.project_id
      WHERE receipt.application_identity_hash = :application_identity_hash
      ORDER BY route, operation_id
    `).all({ ":application_identity_hash": identityHash });
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new LegacyImportApplicationEvidenceError(
      "Import Application has conflicting terminal recovery receipts",
    );
    const row = rows[0]!;
    if (
      (row["route"] !== "restore" && row["route"] !== "forward-repair")
      || typeof row["operation_id"] !== "string"
      || typeof row["application_operation_id"] !== "string"
      || typeof row["project_id"] !== "string"
      || typeof row["backup_id"] !== "string"
      || typeof row["preview_id"] !== "string"
      || typeof row["preview_hash"] !== "string"
    ) {
      throw new LegacyImportApplicationEvidenceError("Import recovery receipt is malformed");
    }
    const isHash = (field: string): boolean => (
      typeof row[field] === "string" && /^sha256:[0-9a-f]{64}$/.test(row[field])
    );
    const isNonNegativeInteger = (field: string): boolean => (
      Number.isSafeInteger(row[field]) && Number(row[field]) >= 0
    );
    const commonMatches = isHash("difference_hash")
      && isNonNegativeInteger("resulting_project_revision")
      && isNonNegativeInteger("resulting_authority_epoch")
      && row["operation_resulting_revision"] === row["resulting_project_revision"]
      && row["operation_resulting_authority_epoch"] === row["resulting_authority_epoch"]
      && row["expected_revision"] === Number(row["resulting_project_revision"]) - 1
      && row["expected_authority_epoch"] === row["resulting_authority_epoch"]
      && row["created_at"] === row["terminal_at"]
      && Number(row["current_revision"]) >= Number(row["resulting_project_revision"])
      && Number(row["current_authority_epoch"]) >= Number(row["resulting_authority_epoch"]);
    let routeMatches = false;
    if (row["route"] === "restore") {
      let lineage: unknown;
      try {
        lineage = JSON.parse(String(row["erased_lineage_json"]));
      } catch {
        lineage = null;
      }
      routeMatches = row["operation_type"] === "import.restore"
        && isHash("erased_lineage_hash")
        && isHash("consent_hash")
        && isHash("verification_hash")
        && isPlainRecord(lineage)
        && canonicalLegacyImportJson(lineage) === row["erased_lineage_json"]
        && hashLegacyImportValue(lineage) === row["erased_lineage_hash"]
        && lineage["schemaVersion"] === 1
        && lineage["applicationOperationId"] === row["application_operation_id"]
        && lineage["applicationIdentityHash"] === identityHash
        && lineage["applicationResultingProjectRevision"]
          === row["application_resulting_project_revision"]
        && lineage["applicationResultingAuthorityEpoch"]
          === row["application_resulting_authority_epoch"]
        && row["application_resulting_project_revision"]
          === Number(row["backup_project_revision"]) + 1
        && row["application_resulting_authority_epoch"] === row["backup_authority_epoch"]
        && row["resulting_project_revision"] === Number(row["backup_project_revision"]) + 1
        && row["resulting_authority_epoch"] === row["backup_authority_epoch"];
    } else {
      let plan: unknown;
      try {
        plan = JSON.parse(String(row["plan_json"]));
      } catch {
        plan = null;
      }
      routeMatches = row["operation_type"] === "import.forward_repair"
        && isHash("plan_hash")
        && isPlainRecord(plan)
        && canonicalLegacyImportJson(plan) === row["plan_json"]
        && hashLegacyImportValue(plan) === row["plan_hash"]
        && plan["applicationOperationId"] === row["application_operation_id"]
        && plan["applicationIdentityHash"] === identityHash
        && plan["previewId"] === row["preview_id"]
        && plan["previewHash"] === row["preview_hash"]
        && plan["backupId"] === row["backup_id"]
        && plan["differenceHash"] === row["difference_hash"]
        && plan["targetCount"] === row["target_count"]
        && plan["mutationCount"] === row["mutation_count"]
        && plan["preservedCount"] === row["preserved_count"]
        && plan["rejectedCount"] === row["rejected_count"]
        && plan["unresolvedCount"] === 0
        && row["target_count"] === Number(row["mutation_count"])
          + Number(row["preserved_count"])
          + Number(row["rejected_count"]);
      if (routeMatches) {
        try {
          const application = inspectLegacyImportApplicationEvidence(
            String(row["application_operation_id"]),
          );
          routeMatches = application.applicationIdentityHash === identityHash
            && application.projectId === row["project_id"]
            && application.preview.preview.preview_id === row["preview_id"]
            && application.preview.preview_hash === row["preview_hash"]
            && application.backupId === row["backup_id"];
        } catch (error) {
          if (!(error instanceof LegacyImportApplicationEvidenceError)) throw error;
          routeMatches = false;
        }
      }
    }
    const events = getDb().prepare(`
      SELECT event_id, event_index, project_id, project_revision, authority_epoch,
             event_type, entity_type, entity_id, caused_by_event_id, payload_json, created_at
      FROM workflow_domain_events WHERE operation_id = :operation_id
      ORDER BY event_index
    `).all({ ":operation_id": row["operation_id"] });
    const outbox = getDb().prepare(`
      SELECT event_id, destination FROM workflow_outbox
      WHERE event_id IN (
        SELECT event_id FROM workflow_domain_events WHERE operation_id = :operation_id
      ) ORDER BY outbox_id
    `).all({ ":operation_id": row["operation_id"] });
    const projections = getDb().prepare(`
      SELECT project_id, projection_key, projection_kind, source_project_revision,
             source_authority_epoch, renderer_version, enqueue_operation_id, created_at
      FROM workflow_projection_work WHERE enqueue_operation_id = :operation_id
      ORDER BY projection_work_id
    `).all({ ":operation_id": row["operation_id"] });
    const event = events[0];
    const projection = projections[0];
    const expectedProjectionKey = row["route"] === "restore"
      ? "legacy-import/restore"
      : "legacy-import/forward-repair";
    const expectedEventPayload = row["route"] === "restore"
      ? canonicalLegacyImportJson({
        applicationOperationId: row["application_operation_id"],
        applicationIdentityHash: identityHash,
        applicationResultingProjectRevision: row["application_resulting_project_revision"],
        applicationResultingAuthorityEpoch: row["application_resulting_authority_epoch"],
        erasedLineageHash: row["erased_lineage_hash"],
        erasedLineageJson: row["erased_lineage_json"],
        previewId: row["preview_id"],
        previewHash: row["preview_hash"],
        backupId: row["backup_id"],
        backupSha256: row["backup_sha256"],
        backupByteSize: row["backup_byte_size"],
        backupSchemaVersion: row["backup_schema_version"],
        backupProjectRevision: row["backup_project_revision"],
        backupAuthorityEpoch: row["backup_authority_epoch"],
        differenceHash: row["difference_hash"],
        consentHash: row["consent_hash"],
        verificationHash: row["verification_hash"],
      })
      : row["plan_json"];
    const deliveryMatches = events.length === 1
      && event?.["event_index"] === 0
      && event["project_id"] === row["project_id"]
      && event["project_revision"] === row["resulting_project_revision"]
      && event["authority_epoch"] === row["resulting_authority_epoch"]
      && event["event_type"] === (row["route"] === "restore"
        ? "legacy-import.restored"
        : "legacy-import.forward-repaired")
      && event["entity_type"] === "legacy-import"
      && event["entity_id"] === row["preview_id"]
      && event["caused_by_event_id"] === null
      && event["payload_json"] === expectedEventPayload
      && event["created_at"] === row["terminal_at"]
      && outbox.length === 1
      && outbox[0]?.["event_id"] === event["event_id"]
      && outbox[0]?.["destination"] === "projection"
      && projections.length === 1
      && projection?.["project_id"] === row["project_id"]
      && projection["projection_key"] === expectedProjectionKey
      && projection["projection_kind"] === "markdown"
      && projection["source_project_revision"] === row["resulting_project_revision"]
      && projection["source_authority_epoch"] === row["resulting_authority_epoch"]
      && projection["renderer_version"] === "v1"
      && projection["enqueue_operation_id"] === row["operation_id"]
      && projection["created_at"] === row["terminal_at"];
    if (!commonMatches || !routeMatches || !deliveryMatches) {
      throw new LegacyImportApplicationEvidenceError("Import recovery receipt is inconsistent");
    }
    return {
      route: row["route"],
      operationId: row["operation_id"],
      applicationOperationId: row["application_operation_id"],
      projectId: row["project_id"],
      backupId: row["backup_id"],
      previewId: row["preview_id"],
      previewHash: row["preview_hash"],
      backupSha256: typeof row["backup_sha256"] === "string" ? row["backup_sha256"] : null,
      backupByteSize: Number.isSafeInteger(row["backup_byte_size"])
        ? Number(row["backup_byte_size"])
        : null,
      backupSchemaVersion: Number.isSafeInteger(row["backup_schema_version"])
        ? Number(row["backup_schema_version"])
        : null,
      backupProjectRevision: Number.isSafeInteger(row["backup_project_revision"])
        ? Number(row["backup_project_revision"])
        : null,
      backupAuthorityEpoch: Number.isSafeInteger(row["backup_authority_epoch"])
        ? Number(row["backup_authority_epoch"])
        : null,
    };
  });
}

function applicationOperationIds(input: AssessmentInputSnapshot): string[] {
  // Matching by preview_id OR preview_hash (plus the recorded identity hash)
  // can return more than one Application. That is never two legitimate
  // Applications of the same preview: workflow_import_applications declares
  // preview_id and preview_hash UNIQUE, and both are content-derived over the
  // same sealed preview envelope, so identical content always produces one
  // identical (preview_id, preview_hash) pair matching exactly one row. A
  // multi-row match therefore proves corrupt or fabricated evidence — a
  // supplied identity split across two stored Applications, or a duplicated
  // legacy-import.applied event carrying the identity hash — and the caller
  // refuses below.
  return readTransaction(() => getDb().prepare(`
    SELECT operation_id FROM workflow_import_applications
    WHERE preview_id = :preview_id OR preview_hash = :preview_hash
    UNION
    SELECT operation_id FROM workflow_domain_events
    WHERE event_type = 'legacy-import.applied'
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.applicationIdentityHash')
        ELSE NULL
      END = :application_identity_hash
    ORDER BY operation_id
  `).all({
    ":preview_id": input.backup.preview_id,
    ":preview_hash": input.backup.preview_hash,
    ":application_identity_hash": input.applicationIdentityHash,
  }).map((row) => String(row["operation_id"])));
}

function applicationMatchesInput(
  application: LegacyImportApplicationEvidence,
  input: AssessmentInputSnapshot,
): boolean {
  const backup = input.backup;
  return application.applicationIdentityHash === input.applicationIdentityHash
    && application.backupArtifactHash === hashLegacyImportValue(backup)
    && application.backupId === backup.backup_id
    && application.preview.preview.preview_id === backup.preview_id
    && application.preview.preview_hash === backup.preview_hash
    && application.backupRef === backup.backup_ref
    && application.backupSha256 === backup.backup_sha256
    && application.backupByteSize === backup.backup_byte_size
    && application.backupSchemaVersion === backup.backup_database_schema_version
    && application.backupProjectRevision === backup.base_project_revision
    && application.backupAuthorityEpoch === backup.base_authority_epoch
    && application.backupQuickCheck === backup.quick_check
    && application.backupVerifiedAt === backup.verified_at
    && application.projectId === backup.project_id
    && application.projectRootRealpath === backup.project_root_realpath;
}

function captureBackupBase(backupRef: string): LegacyImportBaseSnapshot {
  return inspectSqliteReadOnlySnapshot(backupRef, (db) =>
    captureLegacyImportBaseSnapshot({
      readTransaction: (operation) => operation(),
      source: createLegacyImportBaseSnapshotSource(db),
    }),
  );
}

function coordinationCounts(projectRootRealpath: string): LegacyImportRestoreCoordinationCounts {
  const db = getDb();
  return {
    activeWorkers: Number(db.prepare(`SELECT COUNT(*) AS count FROM workers
      WHERE project_root_realpath = :project_root_realpath AND status = 'active'`)
      .get({ ":project_root_realpath": projectRootRealpath })?.["count"] ?? 0),
    heldLeases: Number(db.prepare(
      "SELECT COUNT(*) AS count FROM milestone_leases WHERE status = 'held'",
    ).get()?.["count"] ?? 0),
    activeDispatches: Number(db.prepare(`SELECT COUNT(*) AS count FROM unit_dispatches
      WHERE status IN ('claimed', 'running')`).get()?.["count"] ?? 0),
    activeAttempts: Number(db.prepare(`SELECT COUNT(*) AS count FROM workflow_execution_attempts
      WHERE attempt_state IN ('claimed', 'running')`).get()?.["count"] ?? 0),
  };
}

function captureState(application: LegacyImportApplicationEvidence): AssessmentState {
  return readTransaction(() => {
    const base = captureCurrentLegacyImportBaseSnapshot();
    const head = getDb().prepare(`
      SELECT operation_id, operation_type FROM workflow_operations
      WHERE project_id = :project_id
        AND resulting_revision = :revision
        AND resulting_authority_epoch = :authority_epoch
    `).get({
      ":project_id": base.authority.project_id,
      ":revision": base.authority.revision,
      ":authority_epoch": base.authority.authority_epoch,
    });
    const laterOperationCount = Number(getDb().prepare(`
      SELECT COUNT(*) AS count FROM workflow_operations
      WHERE project_id = :project_id AND resulting_revision > :application_revision
    `).get({
      ":project_id": application.projectId,
      ":application_revision": application.resultingProjectRevision,
    })?.["count"] ?? 0);
    const cutoverCount = Number(getDb().prepare(`
      SELECT COUNT(*) AS count FROM workflow_authority_cutovers
      WHERE project_id = :project_id
        AND resulting_project_revision > :application_revision
    `).get({
      ":project_id": application.projectId,
      ":application_revision": application.resultingProjectRevision,
    })?.["count"] ?? 0);
    return deepFreeze({
      base,
      headOperationId: typeof head?.["operation_id"] === "string" ? head["operation_id"] : null,
      headOperationType: typeof head?.["operation_type"] === "string" ? head["operation_type"] : null,
      laterOperationCount,
      cutoverCount,
      coordination: coordinationCounts(application.projectRootRealpath),
    });
  });
}

function difference(
  backupBase: LegacyImportBaseSnapshot,
  currentBase: LegacyImportBaseSnapshot,
): LegacyImportRestoreDifference {
  const key = (row: LegacyImportBaseRow): string => `${row.row_set}\u0000${row.identity}`;
  const backupRows = new Map(backupBase.rows.map((row) => [key(row), row]));
  const currentRows = new Map(currentBase.rows.map((row) => [key(row), row]));
  const entries: Array<Record<string, unknown>> = [];
  let createdCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  for (const identity of [...new Set([...backupRows.keys(), ...currentRows.keys()])].sort()) {
    const before = backupRows.get(identity);
    const after = currentRows.get(identity);
    let disposition: "created" | "removed" | "changed" | "unchanged";
    if (before === undefined) {
      disposition = "created";
      createdCount += 1;
    } else if (after === undefined) {
      disposition = "removed";
      removedCount += 1;
    } else if (hashLegacyImportValue(before.value) !== hashLegacyImportValue(after.value)) {
      disposition = "changed";
      changedCount += 1;
    } else {
      disposition = "unchanged";
      unchangedCount += 1;
    }
    entries.push({
      identity,
      disposition,
      beforeHash: before === undefined ? null : hashLegacyImportValue(before.value),
      afterHash: after === undefined ? null : hashLegacyImportValue(after.value),
    });
  }
  return deepFreeze({
    createdCount,
    removedCount,
    changedCount,
    unchangedCount,
    differenceHash: hashLegacyImportValue(entries),
  });
}

function facts(
  input: AssessmentInputSnapshot,
  application: LegacyImportApplicationEvidence | null,
  current: LegacyImportBaseSnapshot,
  observedDifference: LegacyImportRestoreDifference | null,
  evidenceExtra: Record<string, unknown>,
): Omit<LegacyImportRestoreAssessmentFacts, "consentStatus"> {
  const coordination = evidenceExtra["coordination"];
  return deepFreeze({
    expectedDatabaseSchemaVersion: input.backup.backup_database_schema_version,
    observedDatabaseSchemaVersion: current.database_schema_version,
    projectId: input.backup.project_id,
    observedProjectId: current.authority.project_id,
    expectedProjectRootRealpath: input.backup.project_root_realpath,
    observedProjectRootRealpath: current.authority.project_root_realpath,
    applicationOperationId: application?.operationId ?? null,
    applicationResultingProjectRevision: application?.resultingProjectRevision ?? null,
    applicationResultingAuthorityEpoch: application?.resultingAuthorityEpoch ?? null,
    expectedRelevantRowsHash: application?.applicationRelevantRowsHash ?? null,
    observedRelevantRowsHash: current.relevant_rows_hash,
    expectedHeadOperationId: application?.operationId ?? null,
    observedHeadOperationId: typeof evidenceExtra["headOperationId"] === "string"
      ? evidenceExtra["headOperationId"]
      : null,
    currentProjectRevision: current.authority.revision,
    currentAuthorityEpoch: current.authority.authority_epoch,
    coordination: isPlainRecord(coordination)
      ? coordination as unknown as LegacyImportRestoreCoordinationCounts
      : null,
    backupVerified: typeof evidenceExtra["backupRelevantRowsHash"] === "string",
    backupId: input.backup.backup_id,
    previewId: input.backup.preview_id,
    previewHash: input.backup.preview_hash,
    difference: observedDifference,
  });
}

function recommendation(
  option: string,
  text: string,
  rationale: string,
  question: string | null = null,
): LegacyImportRestoreRecommendation {
  return { recommendedOptionId: option, recommendationText: text, recommendationRationale: rationale, question };
}

function consentStatus(
  input: AssessmentInputSnapshot,
  evidenceHash: string,
): LegacyImportRestoreAssessmentFacts["consentStatus"] {
  if (input.consent === null) return "missing";
  return input.consent.evidenceHash === evidenceHash ? "matched" : "stale";
}

function result(
  input: AssessmentInputSnapshot,
  application: LegacyImportApplicationEvidence | null,
  current: LegacyImportBaseSnapshot,
  observedDifference: LegacyImportRestoreDifference | null,
  decision: LegacyImportRestoreAssessmentDecision,
  stage: LegacyImportRestoreAssessmentStage,
  reasonCode: string,
  retryable: boolean,
  next: LegacyImportRestoreRecommendation,
  evidenceExtra: Record<string, unknown> = {},
): LegacyImportRestoreAssessment {
  const evidenceFacts = facts(input, application, current, observedDifference, evidenceExtra);
  const evidenceHash = hashLegacyImportValue({
    assessmentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_SCHEMA_VERSION,
    applicationIdentityHash: input.applicationIdentityHash,
    facts: evidenceFacts,
    ...evidenceExtra,
  });
  const resultFacts = deepFreeze({
    ...evidenceFacts,
    consentStatus: consentStatus(input, evidenceHash),
  } satisfies LegacyImportRestoreAssessmentFacts);
  return deepFreeze({
    assessmentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_SCHEMA_VERSION,
    decision,
    stage,
    reasonCode,
    retryable,
    evidenceHash,
    facts: resultFacts,
    recommendation: next,
  });
}

function observedSchemaVersion(): number {
  // A foreign or corrupt database may not carry the schema_version table at
  // all; an unreadable version is reported as -1 so the caller still produces
  // the structured unsupported-schema refusal instead of leaking a raw
  // SQLite error.
  try {
    return Number(getDb().prepare("SELECT MAX(version) AS version FROM schema_version").get()?.["version"] ?? -1);
  } catch {
    return -1;
  }
}

function unsupportedSchemaAssessment(
  input: AssessmentInputSnapshot,
  observedSchema: number,
): LegacyImportRestoreAssessment {
  // The same foreign/corrupt database may also lack project_authority; every
  // fact below already degrades to an empty/-1 observation when the row is
  // absent, so an unreadable table takes the same structured path.
  let authority: Record<string, unknown> | undefined;
  try {
    authority = getDb().prepare(`
      SELECT project_id, project_root_realpath, revision, authority_epoch
      FROM project_authority WHERE singleton = 1
    `).get();
  } catch {
    authority = undefined;
  }
  const evidenceFacts: Omit<LegacyImportRestoreAssessmentFacts, "consentStatus"> = {
    expectedDatabaseSchemaVersion: SCHEMA_VERSION,
    observedDatabaseSchemaVersion: observedSchema,
    projectId: input.backup.project_id,
    observedProjectId: typeof authority?.["project_id"] === "string" ? authority["project_id"] : "",
    expectedProjectRootRealpath: input.backup.project_root_realpath,
    observedProjectRootRealpath: typeof authority?.["project_root_realpath"] === "string"
      ? authority["project_root_realpath"]
      : "",
    applicationOperationId: null,
    applicationResultingProjectRevision: null,
    applicationResultingAuthorityEpoch: null,
    expectedRelevantRowsHash: null,
    observedRelevantRowsHash: null,
    expectedHeadOperationId: null,
    observedHeadOperationId: null,
    currentProjectRevision: Number.isSafeInteger(authority?.["revision"])
      ? Number(authority?.["revision"])
      : -1,
    currentAuthorityEpoch: Number.isSafeInteger(authority?.["authority_epoch"])
      ? Number(authority?.["authority_epoch"])
      : -1,
    coordination: null,
    backupVerified: false,
    backupId: input.backup.backup_id,
    previewId: input.backup.preview_id,
    previewHash: input.backup.preview_hash,
    difference: null,
  };
  const evidenceHash = hashLegacyImportValue({
    assessmentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_SCHEMA_VERSION,
    applicationIdentityHash: input.applicationIdentityHash,
    facts: evidenceFacts,
  });
  const resultFacts: LegacyImportRestoreAssessmentFacts = {
    ...evidenceFacts,
    consentStatus: consentStatus(input, evidenceHash),
  };
  return deepFreeze({
    assessmentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_SCHEMA_VERSION,
    decision: "refused",
    stage: "authority",
    reasonCode: "DATABASE_SCHEMA_UNSUPPORTED",
    retryable: false,
    evidenceHash,
    facts: resultFacts,
    recommendation: recommendation(
      "upgrade-gsd",
      "I recommend opening this project with a compatible gsd-pi version.",
      "Restore cannot be assessed safely against an unsupported database schema.",
    ),
  });
}

function terminalAssessment(
  input: AssessmentInputSnapshot,
  terminal: TerminalReceipt,
): LegacyImportRestoreAssessment {
  const current = captureCurrentLegacyImportBaseSnapshot();
  const terminalMatches = terminal.backupId === input.backup.backup_id
    && terminal.projectId === input.backup.project_id
    && terminal.previewId === input.backup.preview_id
    && terminal.previewHash === input.backup.preview_hash
    && (terminal.route === "forward-repair" || (
      terminal.backupSha256 === input.backup.backup_sha256
      && terminal.backupByteSize === input.backup.backup_byte_size
      && terminal.backupSchemaVersion === input.backup.backup_database_schema_version
      && terminal.backupProjectRevision === input.backup.base_project_revision
      && terminal.backupAuthorityEpoch === input.backup.base_authority_epoch
    ));
  if (!terminalMatches) {
    return result(input, null, current, null, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the recorded recovery evidence.",
        "The supplied backup does not match the terminal recovery receipt."));
  }
  if (terminal.route === "restore") {
    return result(input, null, current, null, "already-restored", "route", "RESTORE_ALREADY_COMMITTED", false,
      recommendation("continue", "I recommend continuing from the restored database.",
        "The exact restore is already recorded, so no further recovery action is needed."),
      { terminalOperationId: terminal.operationId, applicationOperationId: terminal.applicationOperationId });
  }
  return result(input, null, current, null, "forward-repair-required", "route", "FORWARD_REPAIR_ALREADY_COMMITTED", false,
    recommendation("continue", "I recommend continuing from the repaired database.",
      "Forward Repair is already recorded, so destructive restore is permanently closed."),
    { terminalOperationId: terminal.operationId, applicationOperationId: terminal.applicationOperationId });
}

export function assessLegacyImportRestore(value: unknown): LegacyImportRestoreAssessment {
  const input = snapshotInput(value);
  const schemaVersion = observedSchemaVersion();
  if (schemaVersion !== SCHEMA_VERSION) return unsupportedSchemaAssessment(input, schemaVersion);
  let terminal: TerminalReceipt | null;
  try {
    terminal = terminalReceipt(input.applicationIdentityHash);
  } catch {
    const current = captureCurrentLegacyImportBaseSnapshot();
    return result(input, null, current, null, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the recorded recovery evidence.",
        "The database contains conflicting or malformed terminal recovery evidence."));
  }
  if (terminal !== null) {
    return terminalAssessment(input, terminal);
  }

  const operationIds = applicationOperationIds(input);
  if (operationIds.length === 0) {
    const current = captureCurrentLegacyImportBaseSnapshot();
    return result(input, null, current, null, "transaction-rollback-only", "application", "APPLICATION_NOT_COMMITTED", false,
      recommendation("let-transaction-rollback", "I recommend letting the failed transaction roll back.",
        "No Import Application was committed, so there is nothing to restore.", null));
  }
  if (operationIds.length !== 1) {
    // DELIBERATE PERMANENT REFUSAL (do not "resolve" this into a pick):
    // more than one Application matched the supplied identity. Under the
    // schema invariants (UNIQUE preview_id, UNIQUE preview_hash, both
    // content-derived from the same sealed preview envelope) two legitimate
    // Applications can never share either value, so a fully consistent input
    // matches exactly one row by lineage. A multi-row match means the
    // evidence itself is corrupt or fabricated — a supplied identity split
    // across two stored Applications, or a duplicated legacy-import.applied
    // event carrying the identity hash under a second operation. Even when
    // one candidate exactly matches the supplied identity, the presence of a
    // second claimant means the durable evidence cannot be trusted, no retry
    // can change that, and guessing one Application could authorize a
    // destructive restore against the wrong lineage — so this stays
    // refused/APPLICATION_EVIDENCE_INVALID until the evidence is repaired.
    const current = captureCurrentLegacyImportBaseSnapshot();
    return result(input, null, current, null, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the Import Application evidence.",
        "More than one Application matches the supplied identity."));
  }

  let application: LegacyImportApplicationEvidence;
  try {
    application = inspectLegacyImportApplicationEvidence(operationIds[0]!);
  } catch (error) {
    if (!(error instanceof LegacyImportApplicationEvidenceError)) throw error;
    const current = captureCurrentLegacyImportBaseSnapshot();
    return result(input, null, current, null, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the Import Application evidence.",
        "The committed Application lineage is incomplete or inconsistent."));
  }
  if (!applicationMatchesInput(application, input)) {
    const current = captureCurrentLegacyImportBaseSnapshot();
    return result(input, application, current, null, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the Import Application evidence.",
        "The supplied identity or backup does not match the committed Application."));
  }

  const before = captureState(application);
  reachBoundary("after-initial-state");
  let backupBase: LegacyImportBaseSnapshot;
  try {
    backupBase = captureBackupBase(input.backup.backup_ref);
    verifyLegacyImportBackupArtifact({ backup: input.backup, preview: application.preview, base: backupBase });
    reachBoundary("after-backup-verification");
  } catch {
    return result(input, application, before.base, null, "refused", "backup", "BACKUP_EVIDENCE_INVALID", false,
      recommendation("repair-backup-evidence", "I recommend repairing or replacing the verified backup evidence.",
        "The backup cannot be independently verified, so destructive restore is unsafe."));
  }
  let terminalAfterVerification: TerminalReceipt | null;
  try {
    terminalAfterVerification = terminalReceipt(input.applicationIdentityHash);
  } catch {
    const current = captureCurrentLegacyImportBaseSnapshot();
    return result(input, application, current, null, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the recorded recovery evidence.",
        "Terminal recovery evidence changed or became inconsistent during assessment."));
  }
  if (terminalAfterVerification !== null) {
    return terminalAssessment(input, terminalAfterVerification);
  }
  const after = captureState(application);
  const evidenceExtra = {
    backupRelevantRowsHash: backupBase.relevant_rows_hash,
    expectedApplicationRelevantRowsHash: application.applicationRelevantRowsHash,
    currentRelevantRowsHash: after.base.relevant_rows_hash,
    headOperationId: after.headOperationId,
    headOperationType: after.headOperationType,
    laterOperationCount: after.laterOperationCount,
    cutoverCount: after.cutoverCount,
    coordination: after.coordination,
  };
  if (hashLegacyImportValue(before) !== hashLegacyImportValue(after)) {
    return result(input, application, after.base, null, "temporarily-unavailable", "coordination", "ASSESSMENT_STALE", true,
      recommendation("retry-assessment", "I recommend retrying the restore assessment.",
        "Canonical or coordination state changed while the backup was being verified."), evidenceExtra);
  }
  const observedDifference = difference(backupBase, after.base);

  if (after.cutoverCount > 0) {
    return result(input, application, after.base, observedDifference, "forward-repair-required", "route", "AUTHORITY_CUTOVER_COMMITTED", false,
      recommendation("forward-repair", "I recommend Forward Repair.",
        "Authority cutover closed destructive restore; restoring now would erase accepted work."), evidenceExtra);
  }
  if (after.laterOperationCount > 0) {
    return result(input, application, after.base, observedDifference, "forward-repair-required", "route", "LATER_CANONICAL_OPERATION", false,
      recommendation("forward-repair", "I recommend Forward Repair.",
        "Canonical work was accepted after the import, so restoring now would erase accepted work."), evidenceExtra);
  }
  const exactHead = after.base.authority.project_id === application.projectId
    && after.base.authority.revision === application.resultingProjectRevision
    && after.base.authority.authority_epoch === application.resultingAuthorityEpoch
    && after.headOperationId === application.operationId
    && after.headOperationType === "import.apply";
  if (!exactHead) {
    return result(input, application, after.base, observedDifference, "refused", "application", "APPLICATION_EVIDENCE_INVALID", false,
      recommendation("inspect-evidence", "I recommend inspecting the canonical Application lineage.",
        "The database head does not match the Application and no safe recovery route can be proven."), evidenceExtra);
  }
  if (after.base.relevant_rows_hash !== application.applicationRelevantRowsHash) {
    return result(input, application, after.base, observedDifference, "refused", "application", "APPLICATION_STATE_CHANGED", false,
      recommendation("forward-repair", "I recommend Forward Repair after inspecting the unexpected canonical change.",
        "Canonical rows no longer match the exact committed Application state, so destructive restore is unsafe."), evidenceExtra);
  }
  if (Object.values(after.coordination).some((count) => count !== 0)) {
    return result(input, application, after.base, observedDifference, "temporarily-unavailable", "coordination", "COORDINATION_ACTIVE", true,
      recommendation("wait-and-retry", "I recommend waiting for active work to finish, then reassessing.",
        "Restore requires an idle project so no in-flight work can observe a replaced database."), evidenceExtra);
  }

  const consentRequired = result(input, application, after.base, observedDifference, "restore-consent-required", "consent", "DESTRUCTIVE_CONSENT_REQUIRED", false,
    recommendation("restore-backup", "I recommend restoring the verified backup.",
      "The Application is still the exact canonical head and no work has been accepted after it.",
      "This replaces the current database with the verified pre-import backup. Proceed?"), evidenceExtra);
  if (input.consent?.evidenceHash !== consentRequired.evidenceHash) return consentRequired;
  return result(input, application, after.base, observedDifference, "restore-eligible", "consent", "EXACT_RESTORE_WINDOW_OPEN", false,
    recommendation("restore-backup", "I recommend restoring the verified backup now.",
      "Consent matches the current evidence and the exact restore window remains open."), evidenceExtra);
}
