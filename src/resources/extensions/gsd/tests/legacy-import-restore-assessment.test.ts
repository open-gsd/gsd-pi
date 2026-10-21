// Project/App: gsd-pi
// File Purpose: Read-only exact-head restore eligibility and recommendation contract.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
} from "../legacy-import-application.ts";
import {
  canonicalLegacyImportJson,
  createLegacyImportPreview,
  hashLegacyImportValue,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import {
  _setLegacyImportRestoreAssessmentBoundaryForTest,
  assessLegacyImportRestore,
  LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
  type LegacyImportRestoreAssessmentInput,
} from "../legacy-import-restore-assessment.ts";
import {
  _executeImportForwardRepairDomainOperation,
  executeDomainOperation,
  type DomainJsonValue,
} from "../db/domain-operation.ts";
import { SCHEMA_VERSION } from "../db/engine.ts";
import type { LegacyImportForwardRepairPlan } from "../legacy-import-forward-repair-plan.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  cutoverProjectAuthority,
  inspectProjectAuthorityCutoverEvidence,
  PROJECT_AUTHORITY_CONTRACT_VERSION,
  PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
} from "../project-authority-cutover-domain-operation.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();
let sequence = 0;

interface PreparedCase {
  workspace: string;
  databasePath: string;
  base: LegacyImportBaseSnapshot;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
  applicationInput: LegacyImportApplicationInput;
  applicationIdentityHash: string;
}

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function prepareCase(apply = true): PreparedCase {
  sequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-restore-assessment-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: backupDirectory,
    label: "pre-restore-assessment",
  });
  const applicationInput: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/restore-assessment-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "restore-assessment-test",
    },
    previewInput,
    preview,
    backup,
  };
  const applicationIdentityHash = createLegacyImportApplicationIdentity(
    applicationInput,
  ).applicationIdentityHash;
  if (apply) applyLegacyImport(applicationInput);
  return {
    workspace,
    databasePath,
    base,
    preview,
    backup,
    applicationInput,
    applicationIdentityHash,
  };
}

function assessmentInput(prepared: PreparedCase): LegacyImportRestoreAssessmentInput {
  return {
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    changes: row("SELECT total_changes() AS count").count,
    authority: rows("SELECT * FROM project_authority"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    applications: rows("SELECT * FROM workflow_import_applications"),
    restores: rows("SELECT * FROM workflow_import_restores"),
    repairs: rows("SELECT * FROM workflow_import_forward_repairs"),
    cutovers: rows("SELECT * FROM workflow_authority_cutovers"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY projection_work_id"),
  };
}

function seedForwardRepair(prepared: PreparedCase): void {
  const applicationOperationId = String(row(
    "SELECT operation_id FROM workflow_import_applications",
  ).operation_id);
  const differenceHash = hashLegacyImportValue("terminal difference");
  const currentRelevantRowsHash = captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash;
  const plan = {
    planSchemaVersion: 2,
    goal: "revert",
    applicationOperationId,
    applicationIdentityHash: prepared.applicationIdentityHash,
    previewId: prepared.backup.preview_id,
    previewHash: prepared.backup.preview_hash,
    backupId: prepared.backup.backup_id,
    differenceHash,
    expectedProjectRevision: 1,
    expectedAuthorityEpoch: 0,
    baseRelevantRowsHash: prepared.base.relevant_rows_hash,
    applicationRelevantRowsHash: currentRelevantRowsHash,
    currentRelevantRowsHash,
    targetCount: 1,
    mutationCount: 0,
    preservedCount: 1,
    rejectedCount: 0,
    unresolvedCount: 0,
    targets: [{
      instructionIndex: 0,
      targetKind: "milestone",
      targetKey: "M001",
      changeIds: [],
      disposition: "preserve",
      reasonCode: "TEST_TERMINAL_FORWARD_REPAIR",
      reviewHash: null,
      review: null,
      mutation: null,
    }],
  } satisfies LegacyImportForwardRepairPlan;
  _executeImportForwardRepairDomainOperation({
    operationType: "import.forward_repair",
    idempotencyKey: "restore-assessment/terminal-forward-repair",
    expectedRevision: 1,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "internal",
    payload: plan,
  }, (context) => {
    const repairedAt = String(db().prepare(`
      SELECT created_at FROM workflow_operations WHERE operation_id = :operation_id
    `).get({ ":operation_id": context.operationId })?.created_at);
    db().prepare(`
      INSERT INTO workflow_import_forward_repairs (
        operation_id, project_id, application_operation_id, application_identity_hash,
        preview_id, preview_hash, backup_id, difference_hash,
        plan_schema_version, plan_hash, plan_json,
        target_count, mutation_count, preserved_count, rejected_count, unresolved_count,
        repaired_at, resulting_project_revision, resulting_authority_epoch
      ) VALUES (
        :operation_id, :project_id, :application_operation_id, :application_identity_hash,
        :preview_id, :preview_hash, :backup_id, :difference_hash,
        2, :plan_hash, :plan_json, 1, 0, 1, 0, 0,
        :repaired_at, :resulting_revision, :resulting_epoch
      )
    `).run({
      ":operation_id": context.operationId,
      ":project_id": context.projectId,
      ":application_operation_id": applicationOperationId,
      ":application_identity_hash": prepared.applicationIdentityHash,
      ":preview_id": prepared.backup.preview_id,
      ":preview_hash": prepared.backup.preview_hash,
      ":backup_id": prepared.backup.backup_id,
      ":difference_hash": differenceHash,
      ":plan_hash": hashLegacyImportValue(plan),
      ":plan_json": canonicalLegacyImportJson(plan),
      ":repaired_at": repairedAt,
      ":resulting_revision": context.resultingRevision,
      ":resulting_epoch": context.resultingAuthorityEpoch,
    });
    return {
      events: [{
        eventType: "legacy-import.forward-repaired",
        entityType: "legacy-import",
        entityId: prepared.backup.preview_id,
        payload: plan as unknown as DomainJsonValue,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "legacy-import/forward-repair",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

afterEach(() => {
  _setLegacyImportRestoreAssessmentBoundaryForTest(null);
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("restore assessment rejects accessor-backed contracts without reading them", () => {
  let accessed = false;
  const input = {
    get applicationIdentityHash(): string {
      accessed = true;
      throw new Error("must not read");
    },
    backup: {},
  };
  assert.throws(
    () => assessLegacyImportRestore(input),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_RESTORE_ASSESSMENT_CONTRACT_INVALID",
  );
  assert.equal(accessed, false);
});

test("uncommitted Application needs only transaction rollback", () => {
  const prepared = prepareCase(false);
  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "transaction-rollback-only");
  assert.equal(result.reasonCode, "APPLICATION_NOT_COMMITTED");
  assert.equal(result.recommendation.recommendedOptionId, "let-transaction-rollback");
  assert.equal(result.recommendation.question, null);
});

test("exact head recommends restore, requires bound Consent, and remains read-only", () => {
  const prepared = prepareCase();
  const before = durableSnapshot();
  const backupBytes = hashLegacyImportValue([...readFileSync(prepared.backup.backup_ref)]);
  const consentRequired = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(consentRequired.decision, "restore-consent-required");
  assert.equal(consentRequired.reasonCode, "DESTRUCTIVE_CONSENT_REQUIRED");
  assert.equal(consentRequired.recommendation.recommendedOptionId, "restore-backup");
  assert.match(consentRequired.recommendation.recommendationText, /I recommend restoring/);
  assert.match(consentRequired.recommendation.recommendationRationale, /no work has been accepted/);
  assert.match(consentRequired.recommendation.question ?? "", /Proceed\?$/);
  assert.match(consentRequired.evidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(consentRequired), true);
  assertDeepFrozen(consentRequired);
  assert.equal(consentRequired.facts.backupVerified, true);
  assert.equal(consentRequired.facts.consentStatus, "missing");
  assert.equal(consentRequired.facts.expectedHeadOperationId, consentRequired.facts.observedHeadOperationId);
  assert.ok(consentRequired.facts.difference);
  assert.match(consentRequired.facts.difference.differenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(
    consentRequired.facts.difference.createdCount
      + consentRequired.facts.difference.removedCount
      + consentRequired.facts.difference.changedCount > 0,
  );

  const eligible = assessLegacyImportRestore({
    ...assessmentInput(prepared),
    consent: {
      consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      destructiveDatabaseRestore: true,
      evidenceHash: consentRequired.evidenceHash,
    },
  });
  assert.equal(eligible.decision, "restore-eligible");
  assert.equal(eligible.reasonCode, "EXACT_RESTORE_WINDOW_OPEN");
  assert.equal(eligible.evidenceHash, consentRequired.evidenceHash);
  assert.equal(eligible.facts.consentStatus, "matched");
  assert.equal(eligible.recommendation.question, null);
  assert.deepEqual(durableSnapshot(), before);
  assert.equal(hashLegacyImportValue([...readFileSync(prepared.backup.backup_ref)]), backupBytes);
});

test("later canonical work permanently recommends Forward Repair before coordination", () => {
  const prepared = prepareCase();
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: "restore-assessment/later-work",
    expectedRevision: 1,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { accepted: true },
  }, () => ({
    events: [{
      eventType: "milestone.described",
      entityType: "milestone",
      entityId: "M001",
      payload: { accepted: true },
      destinations: ["projection"],
    }],
    projections: [{ projectionKey: "milestone/m001", projectionKind: "state", rendererVersion: "1" }],
  }));
  db().prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at,
      status, project_root_realpath
    ) VALUES (
      'restore-assessment-worker', 'test', 1, '2026-07-17T00:00:00.000Z', '1',
      '2026-07-17T00:00:00.000Z', 'active', :root
    )
  `).run({ ":root": prepared.base.authority.project_root_realpath });

  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "forward-repair-required");
  assert.equal(result.reasonCode, "LATER_CANONICAL_OPERATION");
  assert.equal(result.recommendation.recommendedOptionId, "forward-repair");
  assert.match(result.recommendation.recommendationRationale, /erase accepted work/);
  assert.equal(result.recommendation.question, null);
});

test("cutover closes restore while active coordination is temporarily unavailable", () => {
  let prepared = prepareCase();
  const cutoverEvidence = inspectProjectAuthorityCutoverEvidence();
  cutoverProjectAuthority({
    invocation: {
      idempotencyKey: "restore-assessment/cutover",
      sourceTransport: "internal",
      actorType: "agent",
    },
    expectedRevision: cutoverEvidence.projectRevision,
    expectedAuthorityEpoch: cutoverEvidence.authorityEpoch,
    authorityContractVersion: PROJECT_AUTHORITY_CONTRACT_VERSION,
    evidenceHash: cutoverEvidence.evidenceHash,
    consent: {
      consentSchemaVersion: PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      irreversibleAuthorityCutover: true,
      evidenceHash: cutoverEvidence.evidenceHash,
    },
  });
  let result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "forward-repair-required");
  assert.equal(result.reasonCode, "AUTHORITY_CUTOVER_COMMITTED");

  closeDatabase();
  prepared = prepareCase();
  db().prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at,
      status, project_root_realpath
    ) VALUES (
      'restore-assessment-active', 'test', 1, '2026-07-17T00:00:00.000Z', '1',
      '2026-07-17T00:00:00.000Z', 'active', :root
    )
  `).run({ ":root": prepared.base.authority.project_root_realpath });
  result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "temporarily-unavailable");
  assert.equal(result.reasonCode, "COORDINATION_ACTIVE");
  assert.equal(result.retryable, true);
});

test("missing backup and malformed durable Application evidence refuse without residue", () => {
  let prepared = prepareCase();
  const before = durableSnapshot();
  rmSync(prepared.backup.backup_ref);
  let result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.stage, "backup");
  assert.equal(result.reasonCode, "BACKUP_EVIDENCE_INVALID");
  assert.deepEqual(durableSnapshot(), before);

  closeDatabase();
  prepared = prepareCase();
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  db().prepare(`
    UPDATE workflow_domain_events SET payload_json = '{}'
    WHERE event_type = 'legacy-import.applied'
  `).run();
  result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.stage, "application");
  assert.equal(result.reasonCode, "APPLICATION_EVIDENCE_INVALID");
});

test("an identity split across two stored Applications is refused permanently", () => {
  const prepared = prepareCase();
  // UNIQUE(preview_id) and UNIQUE(preview_hash) make two legitimate
  // Applications of the same preview impossible, so the only way the
  // OR-match can see more than one Application for a fully consistent input
  // is corrupt evidence — here a duplicated legacy-import.applied event
  // carrying the real identity hash under a shadow operation id.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision,
      authority_epoch, event_type, entity_type, entity_id, caused_by_event_id,
      payload_json, created_at
    )
    SELECT
      event_id || ':shadow', operation_id || ':shadow', event_index, project_id,
      project_revision, authority_epoch, event_type, entity_type, entity_id,
      caused_by_event_id, payload_json, created_at
    FROM workflow_domain_events
    WHERE event_type = 'legacy-import.applied'
  `).run();

  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.stage, "application");
  assert.equal(result.reasonCode, "APPLICATION_EVIDENCE_INVALID");
  assert.equal(result.retryable, false);
  assert.match(result.recommendation.recommendationRationale, /More than one Application/);
  // The refusal is deliberate and permanent: reassessment cannot clear it.
  assert.equal(assessLegacyImportRestore(assessmentInput(prepared)).reasonCode, "APPLICATION_EVIDENCE_INVALID");
});

test("restart reproduces the exact same consent-required assessment", () => {
  const prepared = prepareCase();
  const expected = assessLegacyImportRestore(assessmentInput(prepared));
  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  assert.deepEqual(assessLegacyImportRestore(assessmentInput(prepared)), expected);
});

test("stale Consent is ignored until it binds the current evidence", () => {
  const prepared = prepareCase();
  const expected = assessLegacyImportRestore(assessmentInput(prepared));
  const result = assessLegacyImportRestore({
    ...assessmentInput(prepared),
    consent: {
      consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      destructiveDatabaseRestore: true,
      evidenceHash: `sha256:${"0".repeat(64)}`,
    },
  });
  assert.equal(result.decision, "restore-consent-required");
  assert.equal(result.evidenceHash, expected.evidenceHash);
});

test("unrecorded canonical row drift closes the exact restore window", () => {
  const prepared = prepareCase();
  db().prepare("UPDATE milestones SET title = 'out-of-band change' WHERE id = 'M001'").run();
  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.reasonCode, "APPLICATION_STATE_CHANGED");
  assert.equal(result.recommendation.recommendedOptionId, "forward-repair");
});

test("state changing during backup verification returns a retryable stale assessment", () => {
  const prepared = prepareCase();
  _setLegacyImportRestoreAssessmentBoundaryForTest((point) => {
    if (point !== "after-backup-verification") return;
    db().prepare(`
      INSERT INTO workers (
        worker_id, host, pid, started_at, version, last_heartbeat_at,
        status, project_root_realpath
      ) VALUES (
        'restore-assessment-race', 'test', 1, '2026-07-17T00:00:00.000Z', '1',
        '2026-07-17T00:00:00.000Z', 'active', :root
      )
    `).run({ ":root": prepared.base.authority.project_root_realpath });
  });
  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "temporarily-unavailable");
  assert.equal(result.reasonCode, "ASSESSMENT_STALE");
  assert.equal(result.retryable, true);
});

test("unsupported database schema refuses before backup inspection", () => {
  const prepared = prepareCase();
  rmSync(prepared.backup.backup_ref);
  db().prepare(`INSERT INTO schema_version (version, applied_at) VALUES (${SCHEMA_VERSION + 1}, '2026-07-17T00:00:00.000Z')`).run();
  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.stage, "authority");
  assert.equal(result.reasonCode, "DATABASE_SCHEMA_UNSUPPORTED");
  assert.equal(result.facts.observedDatabaseSchemaVersion, SCHEMA_VERSION + 1);
});

test("table-less foreign database refuses with a structured unsupported-schema assessment", () => {
  const prepared = prepareCase();
  // Simulate a foreign/corrupt database that lacks the gsd tables entirely:
  // the assessment contract promises a structured refusal everywhere, never a
  // raw SQLite "no such table" error.
  db().exec("PRAGMA foreign_keys = OFF");
  db().exec("DROP TABLE schema_version");
  db().exec("DROP TABLE project_authority");
  const result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.stage, "authority");
  assert.equal(result.reasonCode, "DATABASE_SCHEMA_UNSUPPORTED");
  assert.equal(result.retryable, false);
  assert.equal(result.facts.observedDatabaseSchemaVersion, -1);
  assert.equal(result.facts.observedProjectId, "");
  assert.equal(result.facts.observedProjectRootRealpath, "");
  assert.equal(result.facts.currentProjectRevision, -1);
  assert.equal(result.facts.currentAuthorityEpoch, -1);
  assert.match(result.evidenceHash, /^sha256:[0-9a-f]{64}$/);
});

test("terminal Forward Repair is re-read during assessment and malformed receipts fail loud", () => {
  const prepared = prepareCase();
  _setLegacyImportRestoreAssessmentBoundaryForTest((point) => {
    if (point === "after-backup-verification") seedForwardRepair(prepared);
  });
  let result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "forward-repair-required");
  assert.equal(result.reasonCode, "FORWARD_REPAIR_ALREADY_COMMITTED");

  _setLegacyImportRestoreAssessmentBoundaryForTest(null);
  db().exec("DROP TRIGGER trg_workflow_import_forward_repair_update");
  db().prepare(`
    UPDATE workflow_import_forward_repairs SET plan_hash = :hash
  `).run({ ":hash": `sha256:${"f".repeat(64)}` });
  result = assessLegacyImportRestore(assessmentInput(prepared));
  assert.equal(result.decision, "refused");
  assert.equal(result.reasonCode, "APPLICATION_EVIDENCE_INVALID");
});

test("terminal recovery requires exactly its route-bound projection identity", () => {
  const prepared = prepareCase();
  seedForwardRepair(prepared);
  db().exec(`
    DROP TRIGGER trg_workflow_projection_identity_immutable;
    DROP TRIGGER trg_workflow_projection_delivery_transition;
  `);

  const operationId = String(row(
    "SELECT operation_id FROM workflow_import_forward_repairs",
  ).operation_id);
  function assertRefused(): void {
    const result = assessLegacyImportRestore(assessmentInput(prepared));
    assert.equal(result.decision, "refused");
    assert.equal(result.reasonCode, "APPLICATION_EVIDENCE_INVALID");
  }

  db().prepare(`
    UPDATE workflow_projection_work SET projection_key = 'legacy-import/wrong'
    WHERE enqueue_operation_id = :operation_id
  `).run({ ":operation_id": operationId });
  assertRefused();
  db().prepare(`
    UPDATE workflow_projection_work SET projection_key = 'legacy-import/forward-repair'
    WHERE enqueue_operation_id = :operation_id
  `).run({ ":operation_id": operationId });

  db().prepare(`
    UPDATE workflow_projection_work SET renderer_version = 'v2'
    WHERE enqueue_operation_id = :operation_id
  `).run({ ":operation_id": operationId });
  assertRefused();
  db().prepare(`
    UPDATE workflow_projection_work SET renderer_version = 'v1'
    WHERE enqueue_operation_id = :operation_id
  `).run({ ":operation_id": operationId });

  db().prepare(`
    INSERT INTO workflow_projection_work (
      projection_work_id, project_id, projection_key, projection_kind,
      supersedes_projection_work_id, source_project_revision, source_authority_epoch,
      renderer_version, enqueue_operation_id, created_at, updated_at
    )
    SELECT projection_work_id || ':tampered', project_id, 'legacy-import/unexpected',
           projection_kind, NULL, source_project_revision, source_authority_epoch,
           renderer_version, enqueue_operation_id, created_at, updated_at
    FROM workflow_projection_work WHERE enqueue_operation_id = :operation_id
  `).run({ ":operation_id": operationId });
  assertRefused();
});
