// Project/App: gsd-pi
// File Purpose: RED contract for strict context-bound legacy import Application writers.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import {
  executeDomainOperation,
  executeImportDomainOperation,
  type DomainOperationContext,
  type DomainOperationMutation,
  type ImportDomainOperationRequest,
} from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { applyLegacyImportApplicationPlan } from "../db/writers/legacy-import-application.ts";
import { LegacyImportApplicationError } from "../legacy-import-application-error.ts";
import type {
  LegacyImportApplicationPlan,
  LegacyImportApplicationPlanInstruction,
} from "../legacy-import-application-plan.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";

type SqlRow = Record<string, unknown>;
type WriterResult = ReturnType<typeof applyLegacyImportApplicationPlan>;

const tempDirs = new Set<string>();
let importSequence = 0;

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "gsd-legacy-import-writer-"));
  tempDirs.add(directory);
  return join(directory, "gsd.db");
}

function openFixture(): void {
  assert.equal(openDatabase(databasePath()), true);
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, bindings: Record<string, unknown> = {}): SqlRow[] {
  return db().prepare(sql).all(bindings);
}

function row(sql: string, bindings: Record<string, unknown> = {}): SqlRow {
  return db().prepare(sql).get(bindings) ?? {};
}

function count(table: string): number {
  return Number(row(`SELECT COUNT(*) AS count FROM ${table}`)["count"] ?? 0);
}

function emptyPreview(
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

function planFor(
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

function rowInstruction(
  action: "create" | "update" | "delete",
  targetKind: "milestone" | "slice" | "task" | "requirement" | "artifact" | "assessment",
  targetKey: string,
  rowSet: "milestones" | "slices" | "tasks" | "requirements" | "artifacts" | "assessments",
  identity: Record<string, null | number | string>,
  values: Record<string, null | number | string>,
  changeId: string,
): LegacyImportApplicationPlanInstruction {
  return { action, targetKind, targetKey, rowSet, identity, values, changeIds: [changeId] };
}

function decisionInstruction(
  action: "create-decision-memory" | "update-decision-memory" | "delete-decision-memory",
  decisionId: string,
  values: Record<string, null | number | string>,
  changeId: string,
): LegacyImportApplicationPlanInstruction {
  return {
    action,
    targetKind: "decision",
    targetKey: decisionId,
    decisionId,
    values,
    changeIds: [changeId],
  };
}

function importRequest(artifact: LegacyImportPreviewArtifact): ImportDomainOperationRequest {
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

function insertImportApplication(
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

function mutation(plan: LegacyImportApplicationPlan): DomainOperationMutation {
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

function applyImport(
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

function targetHash(targetKind: string, targetKey: string): string {
  return hashLegacyImportValue({ kind: targetKind, key: targetKey });
}

function assertInstructionResults(
  result: WriterResult,
  expected: Array<{
    action: string;
    targetKind: string;
    targetKey: string;
    expectedAffectedRows: number;
    affectedRows?: number;
  }>,
): void {
  assert.deepEqual(result.instructionResults, expected.map((entry) => ({
    action: entry.action,
    targetKind: entry.targetKind,
    targetIdentityHash: targetHash(entry.targetKind, entry.targetKey),
    expectedAffectedRows: entry.expectedAffectedRows,
    affectedRows: entry.affectedRows ?? entry.expectedAffectedRows,
  })));
}

function expectWriterFailure(run: () => unknown, message: RegExp): LegacyImportApplicationError {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError);
  assert.equal(observed.stage, "transaction");
  assert.equal(observed.code, "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED");
  assert.equal(observed.retryable, false);
  assert.match(observed.message, message);
  return observed;
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority ORDER BY singleton"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    requirements: rows("SELECT * FROM requirements ORDER BY id"),
    decisions: rows("SELECT * FROM decisions ORDER BY id"),
    memories: rows("SELECT * FROM memories ORDER BY id"),
    artifacts: rows("SELECT * FROM artifacts ORDER BY path"),
    assessments: rows("SELECT * FROM assessments ORDER BY path"),
    dependencies: rows("SELECT * FROM slice_dependencies ORDER BY milestone_id, slice_id, depends_on_slice_id"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY attempt_id"),
    results: rows("SELECT * FROM workflow_attempt_results ORDER BY result_id"),
    checkpoints: rows("SELECT * FROM workflow_kernel_checkpoints ORDER BY kernel_checkpoint_id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    applications: rows("SELECT * FROM workflow_import_applications ORDER BY resulting_project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
  };
}

function seedHierarchy(prefix = "M001"): void {
  db().prepare("INSERT INTO milestones (id, title, status) VALUES (?, ?, ?)")
    .run(prefix, `${prefix} title`, "active");
  db().prepare("INSERT INTO slices (milestone_id, id, title, status) VALUES (?, 'S01', 'Slice', 'pending')")
    .run(prefix);
  db().prepare("INSERT INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, 'S01', 'T01', 'Task', 'pending')")
    .run(prefix);
}

function seedDecisionMemory(id: string, choice: string): void {
  db().prepare(`
    INSERT INTO memories (
      id, category, content, confidence, created_at, updated_at, scope, tags, structured_fields
    ) VALUES (
      :memory_id, 'architecture', :content, 0.85,
      '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z', 'project', '[]', :structured_fields
    )
  `).run({
    ":memory_id": `memory-${id}`,
    ":content": `Decision ${id}: ${choice}`,
    ":structured_fields": canonicalLegacyImportJson({
      sourceDecisionId: id,
      when_context: "Before import",
      scope: "project",
      decision: "Choose storage",
      choice,
      rationale: "Existing rationale",
      revisable: "yes",
      made_by: "human",
      superseded_by: null,
    }),
  });
}

function adoptSeededTask(): void {
  executeDomainOperation({
    operationType: "lifecycle.adopt",
    idempotencyKey: `seed-lifecycle/${importSequence += 1}`,
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "test",
    payload: { task: "M001/S01/T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "pending",
      occurredAt: "2026-07-17T00:00:00.000Z",
    });
    return {
      events: [{
        eventType: "lifecycle.adopted",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { status: "pending" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "planning/m001/s01/t01",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function seedHierarchyDomainEvent(entityType: string, entityId: string): void {
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `seed-domain-history/${importSequence += 1}`,
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "test",
    payload: { entityType, entityId },
  }, () => ({
    events: [{
      eventType: "milestone.described",
      entityType,
      entityId,
      payload: { seeded: true },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `test/domain-history/${entityType}/${entityId}`.toLowerCase(),
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  }));
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

test("writer requires the active import context, Preview hash, and base fence", () => {
  openFixture();
  const artifact = emptyPreview();
  const plan = planFor(artifact, []);
  const before = durableSnapshot();

  assert.throws(() => applyLegacyImportApplicationPlan({
    operationId: "not-active",
    projectId: "project-1",
    resultingRevision: 1,
    resultingAuthorityEpoch: 0,
  }, plan), /^Error: lifecycle writer requires an active Domain Operation context$/);
  assert.deepEqual(durableSnapshot(), before);

  expectWriterFailure(() => executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: "writer/wrong-operation",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    applyLegacyImportApplicationPlan(context, plan);
    return mutation(plan);
  }), /^legacy import Application writer requires an active import\.apply context$/);
  assert.deepEqual(durableSnapshot(), before);

  for (const invalid of [
    planFor(artifact, [], { previewHash: hashLegacyImportValue("wrong-preview") }),
    planFor(artifact, [], { baseProjectRevision: 1 }),
    planFor(artifact, [], { baseAuthorityEpoch: 1 }),
  ]) {
    expectWriterFailure(
      () => applyImport(artifact, invalid),
      /^legacy import Application preview or authority fence does not match the active context$/,
    );
    assert.deepEqual(durableSnapshot(), before);
  }
});

test("writer binds to the active Preview hash and permits receipt-last composition", () => {
  openFixture();
  const artifact = emptyPreview();
  const plan = planFor(artifact, [
    rowInstruction("create", "milestone", "M001", "milestones", { id: "M001" }, {
      id: "M001", title: "Receipt-last milestone",
    }, "receipt-last-context"),
  ]);

  applyImport(artifact, plan);
  assert.equal(row("SELECT title FROM milestones WHERE id = 'M001'")["title"], "Receipt-last milestone");
  assert.equal(count("workflow_import_applications"), 1);
});

test("writer repairs lifecycle shadow drift without replacing canonical authority", () => {
  openFixture();
  seedHierarchy();
  executeDomainOperation({
    operationType: "lifecycle.adopt",
    idempotencyKey: `seed-completed-lifecycle/${importSequence += 1}`,
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "test",
    payload: { task: "M001/S01/T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
      adoptedFromStatus: "completed",
      occurredAt: "2026-07-17T00:00:00.000Z",
    });
    return {
      events: [{
        eventType: "lifecycle.adopted",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: { status: "completed" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "planning/m001/s01/t01",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  db().prepare("UPDATE tasks SET status = 'planned' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'").run();
  const lifecycleBefore = row(`SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id
    FROM workflow_item_lifecycles WHERE task_id = 'T01'`);
  const artifact = emptyPreview(1);
  const instructions: LegacyImportApplicationPlanInstruction[] = [
    rowInstruction(
      "update", "task", "M001/S01/T01", "tasks",
      { milestone_id: "M001", slice_id: "S01", id: "T01" },
      { status: "complete" }, "change-shadow-status",
    ),
    {
      action: "adopt-lifecycle",
      lifecycleAction: "update",
      targetKind: "task-lifecycle",
      targetKey: "M001/S01/T01",
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
      changeIds: ["change-shadow-status"],
    },
  ];

  const result = applyImport(artifact, planFor(artifact, instructions));

  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'")["status"], "complete");
  assert.deepEqual(row(`SELECT lifecycle_id, lifecycle_status, state_version, last_operation_id
    FROM workflow_item_lifecycles WHERE task_id = 'T01'`), lifecycleBefore);
  assertInstructionResults(result, [
    { action: "update", targetKind: "task", targetKey: "M001/S01/T01", expectedAffectedRows: 1 },
    { action: "adopt-lifecycle", targetKind: "task-lifecycle", targetKey: "M001/S01/T01", expectedAffectedRows: 0 },
  ]);
});

test("writer preflights the whole allowlist before any mutation", () => {
  openFixture();
  const artifact = emptyPreview();
  const milestone = rowInstruction(
    "create", "milestone", "M001", "milestones", { id: "M001" },
    { id: "M001", title: "Must never be attempted" }, "change-milestone",
  );
  const before = durableSnapshot();

  const unsupportedField = rowInstruction(
    "create", "milestone", "M001", "milestones", { id: "M001" },
    { id: "M001", invented_column: "unsafe" }, "change-unsupported-field",
  );
  expectWriterFailure(
    () => applyImport(artifact, planFor(artifact, [unsupportedField])),
    /^legacy import values contains unsupported field invented_column$/,
  );
  assert.deepEqual(durableSnapshot(), before);

  const mismatched = {
    ...structuredClone(milestone),
    rowSet: "tasks",
  } as unknown as LegacyImportApplicationPlanInstruction;
  expectWriterFailure(
    () => applyImport(artifact, planFor(artifact, [mismatched])),
    /^legacy import row target mapping is unsupported$/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer preflights forged lifecycle identities and incomplete task coordinates before any mutation", () => {
  openFixture();
  const artifact = emptyPreview();
  const milestone = rowInstruction(
    "create", "milestone", "M001", "milestones", { id: "M001" },
    { id: "M001", title: "Must remain absent" }, "preflight-milestone",
  );
  const lifecycle: LegacyImportApplicationPlanInstruction = {
    action: "adopt-lifecycle",
    lifecycleAction: "create",
    targetKind: "task-lifecycle",
    targetKey: "M001/S01/T01",
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    lifecycleStatus: "pending",
    changeIds: ["preflight-lifecycle"],
  };
  const invalid = [
    {
      instruction: { ...lifecycle, targetKind: "slice-lifecycle" },
      message: /^legacy import lifecycle target identity is inconsistent$/,
    },
    {
      instruction: { ...lifecycle, targetKey: "M001/S01/T99" },
      message: /^legacy import lifecycle target identity is inconsistent$/,
    },
    {
      instruction: { ...lifecycle, sliceId: "", targetKey: "M001//T01" },
      message: /^legacy import lifecycle identity shape is invalid$/,
    },
  ] as unknown as Array<{ instruction: LegacyImportApplicationPlanInstruction; message: RegExp }>;
  const before = durableSnapshot();

  for (const { instruction, message } of invalid) {
    expectWriterFailure(
      () => applyImport(artifact, planFor(artifact, [milestone, instruction])),
      message,
    );
    assert.deepEqual(durableSnapshot(), before);
  }
});

test("writer creates parents first, patches only named fields, and rolls back a late zero-row update", () => {
  openFixture();
  seedHierarchy("M000");
  db().prepare(`
    UPDATE tasks SET title = 'Old title', narrative = 'keep narrative', estimate = 'keep estimate'
    WHERE milestone_id = 'M000' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  const artifact = emptyPreview();
  const instructions: LegacyImportApplicationPlanInstruction[] = [
    rowInstruction("create", "milestone", "M001", "milestones", { id: "M001" }, {
      id: "M001", title: "New milestone", status: "active", key_risks: '{"a":1,"z":2}',
    }, "create-milestone"),
    rowInstruction("create", "slice", "M001/S01", "slices", { milestone_id: "M001", id: "S01" }, {
      milestone_id: "M001", id: "S01", title: "New slice", status: "pending",
    }, "create-slice"),
    rowInstruction("create", "task", "M001/S01/T01", "tasks", {
      milestone_id: "M001", slice_id: "S01", id: "T01",
    }, {
      milestone_id: "M001", slice_id: "S01", id: "T01", title: "New task", status: "pending",
    }, "create-task"),
    rowInstruction("update", "task", "M000/S01/T01", "tasks", {
      milestone_id: "M000", slice_id: "S01", id: "T01",
    }, { title: "Patched title" }, "update-task"),
  ];
  const result = applyImport(artifact, planFor(artifact, instructions));

  assertInstructionResults(result, [
    { action: "create", targetKind: "milestone", targetKey: "M001", expectedAffectedRows: 1 },
    { action: "create", targetKind: "slice", targetKey: "M001/S01", expectedAffectedRows: 1 },
    { action: "create", targetKind: "task", targetKey: "M001/S01/T01", expectedAffectedRows: 1 },
    { action: "update", targetKind: "task", targetKey: "M000/S01/T01", expectedAffectedRows: 1 },
  ]);
  assert.deepEqual(row(`
    SELECT title, narrative, estimate FROM tasks
    WHERE milestone_id = 'M000' AND slice_id = 'S01' AND id = 'T01'
  `), { title: "Patched title", narrative: "keep narrative", estimate: "keep estimate" });
  assert.equal(row("SELECT key_risks FROM milestones WHERE id = 'M001'")["key_risks"], '{"a":1,"z":2}');

  closeDatabase();
  openFixture();
  const failingArtifact = emptyPreview();
  const before = durableSnapshot();
  const lateFailure = planFor(failingArtifact, [
    rowInstruction("create", "milestone", "M009", "milestones", { id: "M009" }, {
      id: "M009", title: "Must roll back",
    }, "early-create"),
    rowInstruction("update", "requirement", "R-MISSING", "requirements", { id: "R-MISSING" }, {
      description: "No matching row",
    }, "late-update"),
  ]);
  expectWriterFailure(
    () => applyImport(failingArtifact, lateFailure),
    /^legacy import update must affect exactly one row$/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer rolls back decision memory and dependency mutations when a later family fails", () => {
  openFixture();
  db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
  for (const id of ["S01", "S02", "S03"]) {
    db().prepare("INSERT INTO slices (milestone_id, id, title) VALUES ('M001', ?, ?)").run(id, id);
  }
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S03', 'S01')
  `).run();
  const artifact = emptyPreview();
  const before = durableSnapshot();
  const plan = planFor(artifact, [
    decisionInstruction("create-decision-memory", "D001", {
      id: "D001", when_context: "", scope: "", decision: "Choose queue",
      choice: "database queue", rationale: "", revisable: "", made_by: "agent",
      source: "planning", superseded_by: null,
    }, "rollback-decision"),
    {
      action: "replace-slice-dependencies",
      targetKind: "slice-dependencies",
      targetKey: "M001/S03",
      milestoneId: "M001",
      sliceId: "S03",
      dependsOnSliceIds: ["S02"],
      changeIds: ["rollback-dependencies"],
    },
    rowInstruction("update", "requirement", "R-MISSING", "requirements", { id: "R-MISSING" }, {
      description: "Late failure",
    }, "rollback-late-failure"),
  ]);

  expectWriterFailure(
    () => applyImport(artifact, plan),
    /^legacy import update must affect exactly one row$/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer replaces slice dependencies as one exact set", () => {
  openFixture();
  db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
  for (const id of ["S01", "S02", "S03"]) {
    db().prepare("INSERT INTO slices (milestone_id, id, title) VALUES ('M001', ?, ?)").run(id, id);
  }
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S03', 'S01')
  `).run();
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S02', 'S01')
  `).run();
  const artifact = emptyPreview();
  const instruction: LegacyImportApplicationPlanInstruction = {
    action: "replace-slice-dependencies",
    targetKind: "slice-dependencies",
    targetKey: "M001/S03",
    milestoneId: "M001",
    sliceId: "S03",
    dependsOnSliceIds: ["S02"],
    changeIds: ["replace-dependencies"],
  };
  const result = applyImport(artifact, planFor(artifact, [instruction]));

  assertInstructionResults(result, [{
    action: "replace-slice-dependencies",
    targetKind: "slice-dependencies",
    targetKey: "M001/S03",
    expectedAffectedRows: 1,
    affectedRows: 2,
  }]);
  assert.deepEqual(rows(`
    SELECT milestone_id, slice_id, depends_on_slice_id FROM slice_dependencies
    ORDER BY milestone_id, slice_id, depends_on_slice_id
  `), [
    { milestone_id: "M001", slice_id: "S02", depends_on_slice_id: "S01" },
    { milestone_id: "M001", slice_id: "S03", depends_on_slice_id: "S02" },
  ]);

  closeDatabase();
  openFixture();
  db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
  db().prepare("INSERT INTO slices (milestone_id, id, title) VALUES ('M001', 'S03', 'Slice')").run();
  const invalidArtifact = emptyPreview();
  const before = durableSnapshot();
  const invalid = { ...instruction, dependsOnSliceIds: ["S99"] };
  expectWriterFailure(
    () => applyImport(invalidArtifact, planFor(invalidArtifact, [invalid])),
    /^legacy import slice dependency parent is missing$/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer adopts only a missing lifecycle at state version zero without fabricated history", () => {
  openFixture();
  seedHierarchy();
  const artifact = emptyPreview();
  const instruction: LegacyImportApplicationPlanInstruction = {
    action: "adopt-lifecycle",
    lifecycleAction: "create",
    targetKind: "task-lifecycle",
    targetKey: "M001/S01/T01",
    itemKind: "task",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    lifecycleStatus: "completed",
    changeIds: ["create-task-lifecycle"],
  };
  const result = applyImport(artifact, planFor(artifact, [instruction]));

  assertInstructionResults(result, [{
    action: "adopt-lifecycle",
    targetKind: "task-lifecycle",
    targetKey: "M001/S01/T01",
    expectedAffectedRows: 1,
  }]);
  assert.deepEqual(row(`
    SELECT item_kind, milestone_id, slice_id, task_id, lifecycle_status, state_version
    FROM workflow_item_lifecycles
  `), {
    item_kind: "task", milestone_id: "M001", slice_id: "S01", task_id: "T01",
    lifecycle_status: "completed", state_version: 0,
  });
  assert.equal(count("workflow_execution_attempts"), 0);
  assert.equal(count("workflow_attempt_results"), 0);
  assert.equal(count("workflow_kernel_checkpoints"), 0);

  closeDatabase();
  openFixture();
  seedHierarchy();
  adoptSeededTask();
  const existingArtifact = emptyPreview(1, 0, "existing-lifecycle");
  const before = durableSnapshot();
  expectWriterFailure(
    () => applyImport(existingArtifact, planFor(existingArtifact, [instruction])),
    /^legacy import lifecycle already exists or was not adopted exactly$/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer validates assessment and artifact parents against the exact live hierarchy", () => {
  openFixture();
  const artifact = emptyPreview();
  const instructions: LegacyImportApplicationPlanInstruction[] = [
    rowInstruction("create", "milestone", "M001", "milestones", { id: "M001" }, {
      id: "M001", title: "Milestone",
    }, "parent-milestone"),
    rowInstruction("create", "slice", "M001/S01", "slices", { milestone_id: "M001", id: "S01" }, {
      milestone_id: "M001", id: "S01", title: "Slice",
    }, "parent-slice"),
    rowInstruction("create", "task", "M001/S01/T01", "tasks", {
      milestone_id: "M001", slice_id: "S01", id: "T01",
    }, {
      milestone_id: "M001", slice_id: "S01", id: "T01", title: "Task",
    }, "parent-task"),
    rowInstruction("create", "assessment", "M001/S01/T01/run-uat", "assessments", {
      path: ".gsd/milestones/M001/slices/S01/tasks/T01/UAT.md",
      milestone_id: "M001", slice_id: "S01", task_id: "T01", scope: "run-uat",
    }, {
      path: ".gsd/milestones/M001/slices/S01/tasks/T01/UAT.md",
      milestone_id: "M001", slice_id: "S01", task_id: "T01", scope: "run-uat",
      status: "pass", full_content: "# UAT\n\nPass.",
    }, "assessment"),
    rowInstruction("create", "artifact", ".gsd/proof.md", "artifacts", { path: ".gsd/proof.md" }, {
      path: ".gsd/proof.md", artifact_type: "evidence", milestone_id: "M001",
      slice_id: "S01", task_id: "T01", full_content: "proof",
    }, "artifact"),
  ];
  applyImport(artifact, planFor(artifact, instructions));
  assert.deepEqual(row("SELECT milestone_id, slice_id, task_id, status, scope, full_content FROM assessments"), {
    milestone_id: "M001", slice_id: "S01", task_id: "T01", status: "pass",
    scope: "run-uat", full_content: "# UAT\n\nPass.",
  });
  assert.deepEqual(row("SELECT milestone_id, slice_id, task_id, full_content FROM artifacts"), {
    milestone_id: "M001", slice_id: "S01", task_id: "T01", full_content: "proof",
  });

  for (const targetKind of ["assessment", "artifact"] as const) {
    closeDatabase();
    openFixture();
    db().prepare("INSERT INTO milestones (id, title) VALUES ('M001', 'Milestone')").run();
    const invalidArtifact = emptyPreview();
    const before = durableSnapshot();
    const invalid = targetKind === "assessment"
      ? rowInstruction("create", "assessment", "M001/S99/T99/run-uat", "assessments", {
        path: ".gsd/invalid-uat.md", milestone_id: "M001", slice_id: "S99", task_id: "T99", scope: "run-uat",
      }, {
        path: ".gsd/invalid-uat.md", milestone_id: "M001", slice_id: "S99", task_id: "T99",
        scope: "run-uat", status: "pass", full_content: "invalid",
      }, "invalid-assessment")
      : rowInstruction("create", "artifact", ".gsd/invalid-artifact.md", "artifacts", {
        path: ".gsd/invalid-artifact.md",
      }, {
        path: ".gsd/invalid-artifact.md", milestone_id: "M001", slice_id: "S99",
        task_id: "T99", full_content: "invalid",
      }, "invalid-artifact");
    expectWriterFailure(
      () => applyImport(invalidArtifact, planFor(invalidArtifact, [invalid])),
      /^legacy import hierarchy parent slice is missing$/,
    );
    assert.deepEqual(durableSnapshot(), before);
  }
});

test("writer creates and patches decisions only through canonical memory structured fields", () => {
  openFixture();
  seedDecisionMemory("D002", "SQLite");
  db().prepare(`
    INSERT INTO decisions (id, decision, choice) VALUES ('D-LEGACY', 'Legacy row', 'must remain')
  `).run();
  const decisionsBefore = rows("SELECT * FROM decisions ORDER BY id");
  const artifact = emptyPreview();
  const instructions: LegacyImportApplicationPlanInstruction[] = [
    decisionInstruction("create-decision-memory", "D001", {
      id: "D001", when_context: "During import", scope: "project",
      decision: "Choose queue", choice: "database queue", rationale: "durable",
      revisable: "yes", made_by: "human", source: "planning", superseded_by: null,
    }, "create-decision"),
    decisionInstruction("update-decision-memory", "D002", {
      choice: "PostgreSQL",
    }, "update-decision"),
  ];
  const result = applyImport(artifact, planFor(artifact, instructions));

  assertInstructionResults(result, [
    { action: "create-decision-memory", targetKind: "decision", targetKey: "D001", expectedAffectedRows: 1 },
    { action: "update-decision-memory", targetKind: "decision", targetKey: "D002", expectedAffectedRows: 1 },
  ]);
  assert.deepEqual(rows("SELECT * FROM decisions ORDER BY id"), decisionsBefore);
  const decisionMemories = rows(`
    SELECT id, structured_fields FROM memories
    WHERE category = 'architecture' AND structured_fields LIKE '%"sourceDecisionId"%'
    ORDER BY json_extract(structured_fields, '$.sourceDecisionId')
  `);
  assert.equal(decisionMemories.length, 2);
  const created = JSON.parse(String(decisionMemories[0]?.["structured_fields"])) as SqlRow;
  const updated = JSON.parse(String(decisionMemories[1]?.["structured_fields"])) as SqlRow;
  assert.equal(created["sourceDecisionId"], "D001");
  assert.equal(created["choice"], "database queue");
  assert.equal(created["source"], "planning");
  assert.equal(updated["sourceDecisionId"], "D002");
  assert.equal(updated["choice"], "PostgreSQL");
  assert.equal(updated["rationale"], "Existing rationale");
  assert.equal(updated["source"], "discussion", "missing legacy source normalizes without losing provenance meaning");

  closeDatabase();
  openFixture();
  db().prepare(`
    INSERT INTO decisions (id, decision, choice, rationale)
    VALUES ('D003', 'Legacy-only decision', 'Keep me', 'Legacy rationale')
  `).run();
  const deleteArtifact = emptyPreview();
  const decisionsBeforeDelete = rows("SELECT * FROM decisions ORDER BY id");
  const deletion = decisionInstruction("delete-decision-memory", "D003", {}, "delete-decision");
  const deleteResult = applyImport(deleteArtifact, planFor(deleteArtifact, [deletion]));
  assertInstructionResults(deleteResult, [{
    action: "delete-decision-memory",
    targetKind: "decision",
    targetKey: "D003",
    expectedAffectedRows: 1,
  }]);
  assert.deepEqual(rows("SELECT * FROM decisions ORDER BY id"), decisionsBeforeDelete);
  const tombstone = row(`
    SELECT structured_fields FROM memories
    WHERE category = 'architecture'
      AND json_extract(structured_fields, '$.sourceDecisionId') = 'D003'
  `);
  assert.deepEqual(JSON.parse(String(tombstone["structured_fields"])), {
    sourceDecisionId: "D003",
    when_context: "",
    scope: "",
    decision: "Legacy-only decision",
    choice: "Keep me",
    rationale: "Legacy rationale",
    revisable: "",
    made_by: "agent",
    source: "discussion",
    superseded_by: null,
    deleted: true,
  });
});

test("writer refuses duplicate canonical decision-memory authority without touching either row", () => {
  openFixture();
  seedDecisionMemory("D004", "SQLite");
  db().prepare(`
    INSERT INTO memories (
      id, category, content, confidence, created_at, updated_at, scope, tags, structured_fields
    )
    SELECT 'memory-D004-duplicate', category, content, confidence, created_at, updated_at,
           scope, tags, structured_fields
    FROM memories WHERE id = 'memory-D004'
  `).run();
  const artifact = emptyPreview();
  const before = durableSnapshot();
  const update = decisionInstruction("update-decision-memory", "D004", {
    choice: "PostgreSQL",
  }, "duplicate-decision-authority");

  assert.throws(
    () => applyImport(artifact, planFor(artifact, [update])),
    /duplicate.*decision|duplicate.*memory|canonical.*authority/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer fails loud on malformed marker-bearing decision memory", () => {
  openFixture();
  db().prepare(`INSERT INTO memories (
    id, category, content, confidence, created_at, updated_at, scope, tags, structured_fields
  ) VALUES (
    'memory-malformed', 'architecture', 'malformed', 0.85,
    '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z',
    'project', '[]', '{"sourceDecisionId":"D005"'
  )`).run();
  const artifact = emptyPreview();
  const before = durableSnapshot();
  const update = decisionInstruction("update-decision-memory", "D005", {
    choice: "PostgreSQL",
  }, "malformed-decision-authority");

  assert.throws(() => applyImport(artifact, planFor(artifact, [update])), /decision memory JSON|invalid/i);
  assert.deepEqual(durableSnapshot(), before);
});

test("writer treats preserve instructions as explicit authority no-ops", () => {
  openFixture();
  seedHierarchy();
  const artifact = emptyPreview();
  const canonicalBefore = {
    milestones: rows("SELECT * FROM milestones"),
    slices: rows("SELECT * FROM slices"),
    tasks: rows("SELECT * FROM tasks"),
    memories: rows("SELECT * FROM memories"),
    artifacts: rows("SELECT * FROM artifacts"),
    assessments: rows("SELECT * FROM assessments"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles"),
  };
  const preserve: LegacyImportApplicationPlanInstruction = {
    action: "preserve",
    targetKind: "legacy-workflow-run",
    targetKey: ".gsd/workflow-runs/run-1.jsonl",
    changeIds: ["preserve-history"],
  };
  const result = applyImport(artifact, planFor(artifact, [preserve]));

  assertInstructionResults(result, [{
    action: "preserve",
    targetKind: "legacy-workflow-run",
    targetKey: ".gsd/workflow-runs/run-1.jsonl",
    expectedAffectedRows: 0,
  }]);
  assert.deepEqual({
    milestones: rows("SELECT * FROM milestones"),
    slices: rows("SELECT * FROM slices"),
    tasks: rows("SELECT * FROM tasks"),
    memories: rows("SELECT * FROM memories"),
    artifacts: rows("SELECT * FROM artifacts"),
    assessments: rows("SELECT * FROM assessments"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles"),
  }, canonicalBefore);
  assert.equal(count("workflow_import_applications"), 1);
});

test("writer deletes an unadopted hierarchy child-first and refuses to strand lifecycle history", () => {
  openFixture();
  seedHierarchy();
  const artifact = emptyPreview();
  const instructions: LegacyImportApplicationPlanInstruction[] = [
    rowInstruction("delete", "task", "M001/S01/T01", "tasks", {
      milestone_id: "M001", slice_id: "S01", id: "T01",
    }, {}, "delete-task"),
    { action: "delete-slice-dependencies", targetKind: "slice-dependencies", targetKey: "M001/S01", milestoneId: "M001", sliceId: "S01", changeIds: ["delete-dependencies"] },
    rowInstruction("delete", "slice", "M001/S01", "slices", { milestone_id: "M001", id: "S01" }, {}, "delete-slice"),
    rowInstruction("delete", "milestone", "M001", "milestones", { id: "M001" }, {}, "delete-milestone"),
  ];
  const result = applyImport(artifact, planFor(artifact, instructions));
  assertInstructionResults(result, [
    { action: "delete", targetKind: "task", targetKey: "M001/S01/T01", expectedAffectedRows: 1 },
    { action: "delete-slice-dependencies", targetKind: "slice-dependencies", targetKey: "M001/S01", expectedAffectedRows: 0 },
    { action: "delete", targetKind: "slice", targetKey: "M001/S01", expectedAffectedRows: 1 },
    { action: "delete", targetKind: "milestone", targetKey: "M001", expectedAffectedRows: 1 },
  ]);
  assert.equal(count("tasks"), 0);
  assert.equal(count("slices"), 0);
  assert.equal(count("milestones"), 0);

  closeDatabase();
  openFixture();
  seedHierarchy();
  adoptSeededTask();
  const adoptedArtifact = emptyPreview(1, 0, "adopted-delete");
  const before = durableSnapshot();
  const deletion = rowInstruction("delete", "task", "M001/S01/T01", "tasks", {
    milestone_id: "M001", slice_id: "S01", id: "T01",
  }, {}, "delete-adopted-task");
  expectWriterFailure(
    () => applyImport(adoptedArtifact, planFor(adoptedArtifact, [deletion])),
    /^legacy import cannot delete hierarchy with adopted lifecycle history$/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer refuses hierarchy deletion that would strand assessment or artifact history", () => {
  for (const evidenceKind of ["assessment", "artifact"] as const) {
    openFixture();
    seedHierarchy();
    if (evidenceKind === "assessment") {
      db().prepare(`
        INSERT INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content)
        VALUES ('.gsd/task-uat.md', 'M001', 'S01', 'T01', 'pass', 'run-uat', 'durable UAT')
      `).run();
    } else {
      db().prepare(`
        INSERT INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content)
        VALUES ('.gsd/task-proof.md', 'evidence', 'M001', 'S01', 'T01', 'durable proof')
      `).run();
    }
    const artifact = emptyPreview(0, 0, `history-${evidenceKind}`);
    const before = durableSnapshot();
    const deletion = rowInstruction("delete", "task", "M001/S01/T01", "tasks", {
      milestone_id: "M001", slice_id: "S01", id: "T01",
    }, {}, `delete-task-with-${evidenceKind}`);

    expectWriterFailure(
      () => applyImport(artifact, planFor(artifact, [deletion])),
      new RegExp(`^legacy import cannot delete hierarchy with retained ${evidenceKind}s history$`),
    );
    assert.deepEqual(durableSnapshot(), before);
    closeDatabase();
  }
});

test("writer blocks matching hierarchy domain history but ignores the same ID for an unrelated entity type", () => {
  openFixture();
  seedHierarchy();
  seedHierarchyDomainEvent("task", "M001/S01/T01");
  const matchingArtifact = emptyPreview(1, 0, "matching-domain-history");
  const deletion = rowInstruction("delete", "task", "M001/S01/T01", "tasks", {
    milestone_id: "M001", slice_id: "S01", id: "T01",
  }, {}, "delete-task-with-domain-history");
  const before = durableSnapshot();

  expectWriterFailure(
    () => applyImport(matchingArtifact, planFor(matchingArtifact, [deletion])),
    /^legacy import cannot delete hierarchy with immutable domain history$/,
  );
  assert.deepEqual(durableSnapshot(), before);

  closeDatabase();
  openFixture();
  seedHierarchy();
  seedHierarchyDomainEvent("legacy-import", "M001/S01/T01");
  const unrelatedArtifact = emptyPreview(1, 0, "unrelated-domain-history");
  const result = applyImport(unrelatedArtifact, planFor(unrelatedArtifact, [deletion]));

  assertInstructionResults(result, [{
    action: "delete",
    targetKind: "task",
    targetKey: "M001/S01/T01",
    expectedAffectedRows: 1,
  }]);
  assert.equal(count("tasks"), 0);
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE entity_type = 'legacy-import' AND entity_id = 'M001/S01/T01'
  `)["count"], 1);
});
