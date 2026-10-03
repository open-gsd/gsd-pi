// Project/App: gsd-pi
// File Purpose: Apply hand-built legacy import Application plans through a real import.apply Domain Operation in tests.

import assert from "node:assert/strict";

import { SCHEMA_VERSION, _getAdapter } from "../../gsd-db.ts";
import {
  executeImportDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
  type ImportDomainOperationRequest,
} from "../../db/domain-operation.ts";
import { applyLegacyImportApplicationPlan } from "../../db/writers/legacy-import-application.ts";
import type {
  LegacyImportApplicationPlan,
  LegacyImportApplicationPlanInstruction,
} from "../../legacy-import-application-plan.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../../legacy-import-preview.ts";

export type WriterResult = ReturnType<typeof applyLegacyImportApplicationPlan>;

let importSequence = 0;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

export function emptyPreview(
  baseProjectRevision = 0,
  baseAuthorityEpoch = 0,
  identity = "default",
): LegacyImportPreviewArtifact {
  const emptyHash = hashLegacyImportValue([]);
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: SCHEMA_VERSION,
      authority: {
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: `/tmp/project-1/${identity}`,
        revision: baseProjectRevision,
        authority_epoch: baseAuthorityEpoch,
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      rows: [],
      relevant_rows_hash: emptyHash,
    },
    source_set_hash: emptyHash,
    change_set_hash: emptyHash,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function planFor(
  artifact: LegacyImportPreviewArtifact,
  instructions: readonly LegacyImportApplicationPlanInstruction[],
  overrides: Partial<LegacyImportApplicationPlan> = {},
): LegacyImportApplicationPlan {
  const mutationCounts = {
    create: instructions.filter((entry) => entry.action === "create").length,
    update: instructions.filter((entry) => entry.action === "update").length,
    delete: instructions.filter((entry) => entry.action === "delete").length,
    replaceSliceDependencies: instructions.filter((entry) => entry.action === "replace-slice-dependencies").length,
    deleteSliceDependencies: instructions.filter((entry) => entry.action === "delete-slice-dependencies").length,
    adoptLifecycle: instructions.filter((entry) => entry.action === "adopt-lifecycle").length,
    seedQualityGate: instructions.filter((entry) => entry.action === "seed-quality-gate").length,
  };
  const affectedTargets = instructions
    .filter((entry) => entry.action !== "preserve")
    .map((entry) => ({ targetKind: entry.targetKind, targetKey: entry.targetKey }));
  const changeIds = instructions.flatMap((entry) => [...entry.changeIds]);
  const receiptCounts = { ...artifact.preview.counts };
  const plan: LegacyImportApplicationPlan = {
    planSchemaVersion: 2,
    previewId: artifact.preview.preview_id,
    previewHash: artifact.preview_hash,
    baseProjectRevision: artifact.preview.base_project_revision,
    baseAuthorityEpoch: artifact.preview.base_authority_epoch,
    receiptCounts,
    instructions: structuredClone(instructions),
    accounting: {
      sourceIds: [], diagnosisIds: [], resolutionIds: [], changeIds,
      preserveChangeIds: instructions
        .filter((entry) => entry.action === "preserve")
        .flatMap((entry) => [...entry.changeIds]),
      unparsedSourceIds: [],
    },
    mutationCounts,
    affectedTargets,
    eventFacts: {
      previewId: artifact.preview.preview_id,
      previewHash: artifact.preview_hash,
      sourceSetHash: artifact.preview.source_set_hash,
      changeSetHash: artifact.preview.change_set_hash,
      receiptCounts,
      mutationCounts,
      affectedTargetHashes: affectedTargets.map((target) => hashLegacyImportValue({
        kind: target.targetKind,
        key: target.targetKey,
      })),
      sourceCount: 0,
      diagnosisCount: 0,
      resolutionCount: 0,
      preserveCount: receiptCounts.preserve,
      unparsedCount: receiptCounts.unparsed,
    },
    projectionKeys: [`legacy-import/${artifact.preview.preview_id}`],
    ...overrides,
  };
  return deepFreeze(structuredClone(plan));
}

export function importRequest(artifact: LegacyImportPreviewArtifact): ImportDomainOperationRequest {
  importSequence += 1;
  return {
    operationType: "import.apply",
    idempotencyKey: `legacy-import/writer-${importSequence}`,
    expectedRevision: artifact.preview.base_project_revision,
    expectedAuthorityEpoch: artifact.preview.base_authority_epoch,
    actorType: "agent",
    actorId: "legacy-import-writer-test",
    sourceTransport: "internal",
    traceId: `trace-${importSequence}`,
    turnId: `turn-${importSequence}`,
    payload: artifact,
  };
}

export function insertImportApplication(
  context: Readonly<DomainOperationContext>,
  artifact: LegacyImportPreviewArtifact,
): void {
  const preview = artifact.preview;
  db().prepare(`
    INSERT INTO workflow_import_applications (
      operation_id, project_id, import_kind, importer_version,
      preview_schema_version, preview_id, preview_hash,
      base_project_revision, base_authority_epoch, base_database_schema_version,
      source_set_hash, change_set_hash,
      create_count, update_count, delete_count, preserve_count, unparsed_count, unresolved_count,
      preview_json,
      backup_ref, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch, backup_quick_check, backup_verified_at,
      applied_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :import_kind, :importer_version,
      :preview_schema_version, :preview_id, :preview_hash,
      :base_project_revision, :base_authority_epoch, :base_database_schema_version,
      :source_set_hash, :change_set_hash,
      :create_count, :update_count, :delete_count, :preserve_count, :unparsed_count, :unresolved_count,
      :preview_json,
      '/tmp/verified-backup.sqlite', :backup_sha256, 1, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch, 'ok', '2026-07-17T00:00:00.000Z',
      '2026-07-17T00:00:01.000Z', :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":import_kind": preview.import_kind,
    ":importer_version": preview.importer_version,
    ":preview_schema_version": preview.preview_schema_version,
    ":preview_id": preview.preview_id,
    ":preview_hash": artifact.preview_hash,
    ":base_project_revision": preview.base_project_revision,
    ":base_authority_epoch": preview.base_authority_epoch,
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
    ":backup_sha256": `sha256:${"2".repeat(64)}`,
    ":backup_schema_version": preview.base_database_schema_version,
    ":backup_project_revision": preview.base_project_revision,
    ":backup_authority_epoch": preview.base_authority_epoch,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
}

export function mutation(plan: LegacyImportApplicationPlan): DomainOperationMutation {
  return {
    events: [{
      eventType: "legacy-import.applied",
      entityType: "legacy-import",
      entityId: plan.previewId,
      payload: { previewId: plan.previewId, previewHash: plan.previewHash },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: plan.projectionKeys[0]!,
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  };
}

export function applyImport(
  artifact: LegacyImportPreviewArtifact,
  plan: LegacyImportApplicationPlan,
): WriterResult {
  let writerResult: WriterResult | undefined;
  executeImportDomainOperation(importRequest(artifact), (context) => {
    writerResult = applyLegacyImportApplicationPlan(context, plan);
    insertImportApplication(context, artifact);
    return mutation(plan);
  });
  assert.ok(writerResult);
  return writerResult;
}
