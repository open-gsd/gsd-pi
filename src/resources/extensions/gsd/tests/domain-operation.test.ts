// Project/App: gsd-pi
// File Purpose: Executable contract for revision-checked, idempotent domain operations.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import {
  SCHEMA_VERSION,
  _getAdapter,
  closeDatabase,
  openDatabase,
  transaction,
} from "../gsd-db.ts";
import { snapshotDatabaseFile } from "../db/engine.ts";
import { createDbAdapter } from "../db-adapter.ts";
import {
  _executeAuthorityCutoverDomainOperation,
  _setDomainOperationFaultForTest,
  assertDomainOperationReceiptComponents,
  executeImportDomainOperation,
  executeDomainOperation,
  type AuthorityCutoverDomainOperationRequest,
  type DomainOperationContext,
  type DomainOperationMutation,
  type DomainOperationRequest,
  type DomainOperationResult,
  type ImportDomainOperationRequest,
} from "../db/domain-operation.ts";
import { insertAuthorityCutoverReceipt } from "../db/writers/authority-recovery.ts";
import {
  GSD_IDEMPOTENCY_CONFLICT,
  GSD_REVISION_CONFLICT,
} from "../errors.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import { rebuildMarkdownProjectionsFromDb } from "../commands-maintenance.ts";
import {
  captureCurrentProjectionWork,
  settleProjectionWork,
} from "../db/writers/projection-work-delivery.ts";

const tempDirs = new Set<string>();
const POST_V30_TABLES = [
  "workflow_settlement_receipts",
  "workflow_closeout_effects",
  "workflow_closeout_plans",
  "workflow_kernel_checkpoints",
  "workflow_import_applications",
  "workflow_projection_work",
  "workflow_remediation_links",
  "workflow_human_acceptances",
  "workflow_verification_evidence",
  "workflow_technical_verdicts",
  "workflow_acceptance_criteria",
  "workflow_recovery_actions",
  "workflow_recovery_budgets",
  "workflow_failure_observations",
  "workflow_decision_impacts",
  "workflow_work_checkpoints",
  "workflow_conversation_decisions",
  "workflow_answers",
  "workflow_interaction_options",
  "workflow_interactions",
  "workflow_question_dependencies",
  "workflow_open_questions",
  "workflow_milestone_contexts",
  "workflow_requirement_dispositions",
  "workflow_waivers",
  "workflow_blockers",
  "workflow_attempt_results",
  "workflow_execution_attempts",
  "workflow_item_lifecycles",
  "workflow_outbox",
  "workflow_domain_events",
  "workflow_operations",
  "project_authority",
] as const;

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-domain-operation-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function openFixture(t: TestContext): string {
  const path = databasePath();
  assert.equal(openDatabase(path), true);
  t.after(closeDatabase);
  return path;
}

function createV30Backup(): string {
  const sourcePath = databasePath();
  assert.equal(openDatabase(sourcePath), true);
  const db = _getAdapter();
  assert.ok(db);
  db.exec("PRAGMA foreign_keys = OFF");
  for (const table of POST_V30_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(`
    DELETE FROM schema_version;
    INSERT INTO schema_version (version, applied_at)
    VALUES (30, '2026-07-12T00:00:00.000Z');
    INSERT OR IGNORE INTO milestones (id, title, status, created_at)
    VALUES ('M-LEGACY', 'Preserved from v30', 'active', '2026-07-12T00:00:00.000Z');
    INSERT OR IGNORE INTO audit_events
      (event_id, trace_id, category, type, ts, payload_json)
    VALUES
      ('audit-v30', 'trace-v30', 'workflow', 'legacy',
       '2026-07-12T00:00:00.000Z', '{"preserved":true}');
  `);
  closeDatabase();
  const backupPath = join(dirname(sourcePath), "v30-backup.db");
  snapshotDatabaseFile(sourcePath, backupPath);
  return backupPath;
}

function request(overrides: Partial<DomainOperationRequest> = {}): DomainOperationRequest {
  return {
    operationType: "milestone.describe",
    idempotencyKey: "transport/request-1",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "user",
    actorId: "developer",
    sourceTransport: "test",
    traceId: "trace-1",
    turnId: "turn-1",
    payload: { milestoneId: "M001", title: "Domain operation" },
    ...overrides,
  };
}

function importPreview(
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

function importRequest(
  payload = importPreview(),
  overrides: Partial<ImportDomainOperationRequest> = {},
): ImportDomainOperationRequest {
  return {
    operationType: "import.apply",
    idempotencyKey: "legacy-import/application-1",
    expectedRevision: payload.preview.base_project_revision,
    expectedAuthorityEpoch: payload.preview.base_authority_epoch,
    actorType: "agent",
    actorId: "legacy-import",
    sourceTransport: "internal",
    traceId: "legacy-import-trace-1",
    turnId: "legacy-import-turn-1",
    payload,
    ...overrides,
  };
}

function insertImportApplication(
  context: Readonly<DomainOperationContext>,
  artifact: LegacyImportPreviewArtifact,
  previewJson = canonicalLegacyImportJson(artifact.preview),
): void {
  const db = _getAdapter();
  assert.ok(db);
  const preview = artifact.preview;
  db.prepare(`
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
      :backup_ref, :backup_sha256, :backup_byte_size, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch, 'ok', :backup_verified_at,
      :applied_at, :resulting_project_revision, :resulting_authority_epoch
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
    ":preview_json": previewJson,
    ":backup_ref": "/tmp/verified-backup.sqlite",
    ":backup_sha256": `sha256:${"2".repeat(64)}`,
    ":backup_byte_size": 1,
    ":backup_schema_version": preview.base_database_schema_version,
    ":backup_project_revision": preview.base_project_revision,
    ":backup_authority_epoch": preview.base_authority_epoch,
    ":backup_verified_at": "2026-07-17T00:00:00.000Z",
    ":applied_at": "2026-07-17T00:00:01.000Z",
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
}

function mutation(
  projectionKey = "status/project",
  entityId = "M001",
): DomainOperationMutation {
  return {
    events: [
      {
        eventType: "milestone.description.started",
        entityType: "milestone",
        entityId,
        payload: { milestoneId: entityId, step: 1 },
        destinations: ["projection", "telemetry"],
      },
      {
        eventType: "milestone.description.completed",
        entityType: "milestone",
        entityId,
        payload: { milestoneId: entityId, step: 2 },
        destinations: ["projection"],
      },
    ],
    projections: [
      {
        projectionKey,
        projectionKind: "markdown",
        rendererVersion: "v1",
      },
    ],
  };
}

function execute(
  operationRequest: DomainOperationRequest = request(),
  mutate: (context: Readonly<DomainOperationContext>) => DomainOperationMutation = () => mutation(),
): DomainOperationResult {
  return executeDomainOperation(operationRequest, mutate);
}

function rows(sql: string): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db);
  return db.prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  const db = _getAdapter();
  assert.ok(db);
  return db.prepare(sql).get() ?? {};
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: row("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    applications: rows("SELECT * FROM workflow_import_applications ORDER BY resulting_project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
    callbackResidue: rows("SELECT scope, scope_id, key, value_json FROM runtime_kv WHERE key = 'domain-operation-fault-probe'"),
  };
}

function assertCommittedReceipt(result: DomainOperationResult, revision: number, epoch = 0): void {
  assert.equal(result.status, "committed");
  assert.equal(result.resultingRevision, revision);
  assert.equal(result.resultingAuthorityEpoch, epoch);
  assert.match(result.operationId, /\S/);
  assert.match(result.projectId, /\S/);
  assert.match(result.requestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.eventIds.length, 2);
  assert.equal(new Set(result.eventIds).size, 2);
  assert.equal(result.outboxIds.length, 3);
  assert.ok(result.outboxIds.every((id) => Number.isInteger(id) && id > 0));
  assert.equal(result.projectionWorkIds.length, 1);
}

function assertErrorCode(
  fn: () => unknown,
  code: string,
  message: RegExp,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code);
    assert.match(String((error as Error).message), message);
    return true;
  });
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("the public database barrel does not expose the fault injection hook", async () => {
  const publicDatabase = await import("../gsd-db.ts");

  assert.equal("_setDomainOperationFaultForTest" in publicDatabase, false);
});

test("one operation atomically commits provenance, ordered events, outbox, projection, and authority", (t) => {
  openFixture(t);
  let contextSeen: Readonly<DomainOperationContext> | undefined;

  const result = execute(request(), (context) => {
    contextSeen = context;
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.resultingRevision, 1);
    assert.equal(context.resultingAuthorityEpoch, 0);
    return mutation();
  });

  assertCommittedReceipt(result, 1);
  assert.equal(
    result.requestHash,
    "sha256:bde457368fdcea8d5b1497ec20bcc7e822824c0e66ac86c910e3adbd75d72908",
  );
  assert.equal(contextSeen?.operationId, result.operationId);
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 1,
    authority_epoch: 0,
  });
  assert.deepEqual(
    rows("SELECT operation_id, event_index, project_revision, authority_epoch FROM workflow_domain_events ORDER BY event_index"),
    [
      { operation_id: result.operationId, event_index: 0, project_revision: 1, authority_epoch: 0 },
      { operation_id: result.operationId, event_index: 1, project_revision: 1, authority_epoch: 0 },
    ],
  );
  assert.deepEqual(
    rows("SELECT event_id, destination FROM workflow_outbox ORDER BY outbox_id").map(({ event_id, destination }) => ({ event_id, destination })),
    [
      { event_id: result.eventIds[0], destination: "projection" },
      { event_id: result.eventIds[0], destination: "telemetry" },
      { event_id: result.eventIds[1], destination: "projection" },
    ],
  );
  assert.deepEqual(
    row("SELECT projection_key, source_project_revision, source_authority_epoch, enqueue_operation_id, supersedes_projection_work_id, delivery_state FROM workflow_projection_work"),
    {
      projection_key: "status/project",
      source_project_revision: 1,
      source_authority_epoch: 0,
      enqueue_operation_id: result.operationId,
      supersedes_projection_work_id: null,
      delivery_state: "pending",
    },
  );
});

test("projection rebuild delivers current durable Projection Work", async (t) => {
  const dbPath = openFixture(t);
  execute();

  const result = await rebuildMarkdownProjectionsFromDb(dirname(dbPath));

  assert.deepEqual(result.errors, []);
  const projection = row(`
    SELECT delivery_state, attempt_count, rendered_content_hash
    FROM workflow_projection_work
  `);
  assert.equal(projection["delivery_state"], "rendered");
  assert.equal(projection["attempt_count"], 1);
  assert.match(String(projection["rendered_content_hash"]), /^sha256:[0-9a-f]{64}$/);
});

test("failed projection delivery records diagnostic retry state", (t) => {
  openFixture(t);
  execute();

  const batch = captureCurrentProjectionWork();
  assert.equal(settleProjectionWork(batch, { outcome: "failed", error: "disk full" }), 1);

  const projection = row(`
    SELECT delivery_state, attempt_count, next_attempt_at, last_error
    FROM workflow_projection_work
  `);
  assert.equal(projection["delivery_state"], "pending");
  assert.equal(projection["attempt_count"], 1);
  assert.match(String(projection["next_attempt_at"]), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(projection["last_error"], "disk full");
});

test("projection delivery leaves work enqueued during rendering pending", (t) => {
  openFixture(t);
  const first = execute();
  const renderedBatch = captureCurrentProjectionWork();
  const second = execute(
    request({ idempotencyKey: "transport/request-2", expectedRevision: 1 }),
  );

  assert.equal(settleProjectionWork(renderedBatch, {
    outcome: "rendered",
    contentHash: `sha256:${"a".repeat(64)}`,
  }), 0);
  assert.deepEqual(
    rows(`
      SELECT projection_work_id, delivery_state, rendered_content_hash
      FROM workflow_projection_work
      ORDER BY source_project_revision
    `),
    [
      {
        projection_work_id: first.projectionWorkIds[0],
        delivery_state: "pending",
        rendered_content_hash: null,
      },
      {
        projection_work_id: second.projectionWorkIds[0],
        delivery_state: "pending",
        rendered_content_hash: null,
      },
    ],
  );
});

test("import.apply Domain Operation: generic executor refuses the reserved operation", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  let mutationCalls = 0;

  assert.throws(
    () => executeDomainOperation(request({ operationType: "import.apply" }), () => {
      mutationCalls += 1;
      return mutation();
    }),
    /import\.apply.*executeImportDomainOperation/i,
  );
  assert.equal(mutationCalls, 0);
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: typed executor is internal and hard-requires its fixed mode", async (t) => {
  openFixture(t);
  const publicDatabase = await import("../gsd-db.ts");
  const before = durableSnapshot();
  let mutationCalls = 0;
  const invalidRequests = [
    { ...importRequest(), operationType: "milestone.describe" },
    { ...importRequest(), advanceAuthorityEpoch: true },
    { ...importRequest(), expectedRevision: 1 },
    { ...importRequest(), expectedAuthorityEpoch: 1 },
  ] as unknown as ImportDomainOperationRequest[];

  assert.equal("executeImportDomainOperation" in publicDatabase, false);
  for (const invalid of invalidRequests) {
    assert.throws(
      () => executeImportDomainOperation(invalid, () => {
        mutationCalls += 1;
        return mutation();
      }),
      /import\.apply|Authority Epoch|advanceAuthorityEpoch/i,
    );
    assert.deepEqual(durableSnapshot(), before);
  }
  assert.equal(mutationCalls, 0);
});

test("import.apply Domain Operation: rejects accessor-backed request identity without reading it", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const accessorRequest = importRequest() as unknown as Record<string, unknown>;
  let operationTypeReads = 0;
  Object.defineProperty(accessorRequest, "operationType", {
    enumerable: true,
    get: () => {
      operationTypeReads += 1;
      return operationTypeReads < 3 ? "milestone.describe" : "import.apply";
    },
  });

  assert.throws(
    () => executeDomainOperation(
      accessorRequest as unknown as DomainOperationRequest,
      () => mutation(),
    ),
    /operationType.*data property/i,
  );
  assert.equal(operationTypeReads, 0);
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: rejects an unsealed Preview before mutation", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const malformed = structuredClone(importPreview()) as unknown as {
    preview: Record<string, unknown>;
    preview_hash: string;
  };
  malformed.preview["extra"] = true;
  malformed.preview_hash = hashLegacyImportValue(malformed.preview);
  let mutationCalls = 0;

  assert.throws(
    () => executeImportDomainOperation(
      importRequest(malformed as unknown as LegacyImportPreviewArtifact),
      () => {
        mutationCalls += 1;
        return mutation();
      },
    ),
    /sealed.*Preview|Preview.*invalid/i,
  );
  assert.equal(mutationCalls, 0);
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: rejects nested Preview accessors without invoking them", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const artifact = structuredClone(importPreview());
  const preview = artifact.preview;
  let previewReads = 0;
  Object.defineProperty(artifact, "preview", {
    enumerable: true,
    get: () => {
      previewReads += 1;
      _getAdapter()?.prepare(`
        INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
        VALUES ('project', '', 'domain-operation-fault-probe', '{}', '2026-07-17T00:00:00.000Z')
      `).run();
      return preview;
    },
  });
  const operationRequest = {
    ...importRequest(),
    payload: artifact,
  } as unknown as ImportDomainOperationRequest;

  assert.throws(
    () => executeImportDomainOperation(operationRequest, () => mutation()),
    /Preview.*strict data|accessor/i,
  );
  assert.equal(previewReads, 0);
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: typed executor commits one exact Application receipt", (t) => {
  openFixture(t);
  const preview = importPreview();
  const result = executeImportDomainOperation(importRequest(preview), (context) => {
    insertImportApplication(context, preview);
    return mutation();
  });

  assertCommittedReceipt(result, 1, 0);
  assert.equal(result.requestHash, preview.preview_hash);
  assert.deepEqual(
    row(`SELECT operation_type, request_hash, expected_revision, resulting_revision,
               expected_authority_epoch, resulting_authority_epoch
         FROM workflow_operations WHERE operation_id = '${result.operationId}'`),
    {
      operation_type: "import.apply",
      request_hash: preview.preview_hash,
      expected_revision: 0,
      resulting_revision: 1,
      expected_authority_epoch: 0,
      resulting_authority_epoch: 0,
    },
  );
  assert.deepEqual(
    row(`SELECT COUNT(*) AS count, preview_id, preview_hash, base_project_revision,
               resulting_project_revision, base_authority_epoch, resulting_authority_epoch
         FROM workflow_import_applications WHERE operation_id = '${result.operationId}'`),
    {
      count: 1,
      preview_id: preview.preview.preview_id,
      preview_hash: preview.preview_hash,
      base_project_revision: 0,
      resulting_project_revision: 1,
      base_authority_epoch: 0,
      resulting_authority_epoch: 0,
    },
  );
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1"), {
    revision: 1,
    authority_epoch: 0,
  });
});

test("import.apply Domain Operation: missing Application receipt rolls back before authority CAS", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  _setDomainOperationFaultForTest("before-cas");

  assert.throws(
    () => executeImportDomainOperation(importRequest(), () => mutation()),
    /exactly one matching Application receipt/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: noncanonical Application Preview JSON rolls back", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const preview = importPreview();

  assert.throws(
    () => executeImportDomainOperation(importRequest(preview), (context) => {
      insertImportApplication(context, preview, JSON.stringify(preview.preview));
      return mutation();
    }),
    /exactly one matching Application receipt/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: caller mutation cannot change the validated Preview", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const preview = structuredClone(importPreview());

  assert.throws(
    () => executeImportDomainOperation(importRequest(preview), (context) => {
      preview.preview.importer_version = "changed-during-mutation";
      insertImportApplication(context, preview);
      return mutation();
    }),
    /exactly one matching Application receipt/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: pre-CAS fault rolls back its Application and shared output", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const preview = importPreview();
  _setDomainOperationFaultForTest("before-cas");

  assert.throws(
    () => executeImportDomainOperation(importRequest(preview), (context) => {
      insertImportApplication(context, preview);
      return mutation();
    }),
    /before-cas/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("import.apply Domain Operation: exact retry replays and scalar or Preview drift conflicts", (t) => {
  openFixture(t);
  const preview = importPreview();
  let mutationCalls = 0;
  const original = executeImportDomainOperation(importRequest(preview), (context) => {
    mutationCalls += 1;
    insertImportApplication(context, preview);
    return mutation();
  });
  const committed = durableSnapshot();
  const replay = executeImportDomainOperation(importRequest(preview), () => {
    mutationCalls += 1;
    throw new Error("import replay must not invoke mutation");
  });

  assert.equal(mutationCalls, 1);
  assert.deepEqual(replay, { ...original, status: "replayed" });
  for (const conflicting of [
    importRequest(preview, { actorId: "different-agent" }),
    importRequest(importPreview(0, 0, "changed")),
  ]) {
    assertErrorCode(
      () => executeImportDomainOperation(conflicting, () => mutation()),
      GSD_IDEMPOTENCY_CONFLICT,
      /idempotency conflict/i,
    );
    assert.deepEqual(durableSnapshot(), committed);
  }
});

test("import.apply Domain Operation: stale Preview revision and epoch leave no import residue", (t) => {
  openFixture(t);
  let mutationCalls = 0;
  const revisionBefore = durableSnapshot();
  assertErrorCode(
    () => executeImportDomainOperation(importRequest(importPreview(1, 0)), () => {
      mutationCalls += 1;
      return mutation();
    }),
    GSD_REVISION_CONFLICT,
    /stale project revision/i,
  );
  assert.deepEqual(durableSnapshot(), revisionBefore);

  _getAdapter()?.prepare(`
    UPDATE project_authority SET revision = 1, authority_epoch = 1
    WHERE singleton = 1
  `).run();
  const epochBefore = durableSnapshot();
  assertErrorCode(
    () => executeImportDomainOperation(importRequest(importPreview(1, 0)), () => {
      mutationCalls += 1;
      return mutation();
    }),
    GSD_REVISION_CONFLICT,
    /stale authority epoch/i,
  );
  assert.equal(mutationCalls, 0);
  assert.deepEqual(durableSnapshot(), epochBefore);
});

test("import.apply Domain Operation: writer contention remains a revision conflict", (t) => {
  const dbPath = openFixture(t);
  const blocker = createDbAdapter(new DatabaseSync(dbPath));
  blocker.exec("BEGIN IMMEDIATE");
  t.after(() => {
    blocker.exec("ROLLBACK");
    blocker.close();
  });
  _getAdapter()?.exec("PRAGMA busy_timeout = 1");
  let mutationCalls = 0;

  assertErrorCode(
    () => executeImportDomainOperation(importRequest(), () => {
      mutationCalls += 1;
      return mutation();
    }),
    GSD_REVISION_CONFLICT,
    /writer contention/i,
  );
  assert.equal(mutationCalls, 0);
});

test("exact idempotency replay returns the original receipt without rerunning mutation", (t) => {
  const dbPath = openFixture(t);
  let calls = 0;
  const original = execute(request(), () => {
    calls += 1;
    return mutation();
  });
  const before = durableSnapshot();

  const replay = execute(
    request({ payload: { title: "Domain operation", milestoneId: "M001" } }),
    () => {
      calls += 1;
      throw new Error("replay must not invoke mutation");
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(replay, { ...original, status: "replayed" });
  assert.deepEqual(durableSnapshot(), before);

  closeDatabase();
  assert.equal(openDatabase(dbPath), true);
  const reopened = execute(request(), () => {
    throw new Error("reopened replay must not invoke mutation");
  });
  assert.deepEqual(reopened, replay);
  assert.deepEqual(durableSnapshot(), before);
});

test("outbox receipt identities remain durable on an existing v35 database", (t) => {
  const dbPath = openFixture(t);
  const original = execute();
  const db = _getAdapter();
  assert.ok(db);
  db.exec("DROP TRIGGER IF EXISTS trg_workflow_outbox_delete");
  closeDatabase();
  assert.equal(openDatabase(dbPath), true);

  assert.throws(
    () => _getAdapter()?.exec("DELETE FROM workflow_outbox WHERE outbox_id = 1"),
    /outbox.*durable history/i,
  );
  const replay = execute(request(), () => {
    throw new Error("durable receipt replay must not invoke mutation");
  });
  assert.deepEqual(replay, { ...original, status: "replayed" });
});

test("replay rejects damaged duplicated trace provenance", (t) => {
  openFixture(t);
  const original = execute();
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(`
    UPDATE workflow_operations SET trace_id = 'damaged-trace'
    WHERE operation_id = :operation_id
  `).run({ ":operation_id": original.operationId });

  assertErrorCode(
    () => execute(),
    GSD_IDEMPOTENCY_CONFLICT,
    /idempotency conflict/i,
  );
});

test("same idempotency key rejects every mismatched semantic tuple before stale checks", (t) => {
  openFixture(t);
  execute();
  const before = durableSnapshot();
  const mismatches: DomainOperationRequest[] = [
    request({ payload: { milestoneId: "M001", title: "Changed" } }),
    request({ operationType: "milestone.rename" }),
    request({ actorId: "someone-else" }),
    request({ sourceTransport: "other" }),
    request({ expectedRevision: 1 }),
    request({ expectedAuthorityEpoch: 1 }),
  ];

  for (const mismatched of mismatches) {
    assertErrorCode(
      () => execute(mismatched),
      GSD_IDEMPOTENCY_CONFLICT,
      /idempotency conflict/i,
    );
    assert.deepEqual(durableSnapshot(), before);
  }
});

test("stale revision and stale Authority Epoch fail loudly with no residue", (t) => {
  openFixture(t);
  const initial = durableSnapshot();
  assertErrorCode(
    () => execute(request({ expectedRevision: 1 })),
    GSD_REVISION_CONFLICT,
    /stale project revision/i,
  );
  assert.deepEqual(durableSnapshot(), initial);
  assertErrorCode(
    () => execute(request({ expectedAuthorityEpoch: 1 })),
    GSD_REVISION_CONFLICT,
    /stale authority epoch/i,
  );
  assert.deepEqual(durableSnapshot(), initial);
});

test("revision and Authority Epoch inputs require safe increment headroom", (t) => {
  openFixture(t);
  const initial = durableSnapshot();
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  const invalidRequests: DomainOperationRequest[] = [
    request({ expectedRevision: unsafeInteger }),
    request({ expectedRevision: Number.MAX_SAFE_INTEGER }),
    request({ expectedAuthorityEpoch: unsafeInteger }),
  ];

  for (const invalidRequest of invalidRequests) {
    assert.throws(
      () => execute(invalidRequest),
      /safe integer|increment headroom/i,
    );
    assert.deepEqual(durableSnapshot(), initial);
  }
});

test("outbox identities outside the safe integer range abort the operation", (t) => {
  openFixture(t);
  const db = _getAdapter();
  assert.ok(db);
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('workflow_outbox', :seq)")
    .run({ ":seq": Number.MAX_SAFE_INTEGER });
  const before = durableSnapshot();

  assert.throws(
    () => execute(request({ idempotencyKey: "unsafe-outbox-id" })),
    /outbox.*safe integer/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("advanceAuthorityEpoch rejects every retired runtime input", (t) => {
  openFixture(t);
  const initial = durableSnapshot();
  const malformed = {
    ...request(),
    advanceAuthorityEpoch: "true",
  } as unknown as DomainOperationRequest;

  assert.throws(
    () => execute(malformed),
    /advanceAuthorityEpoch.*not accepted/i,
  );
  assert.deepEqual(durableSnapshot(), initial);
});

test("the Domain Operation owns the outer reserved-writer transaction", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  assert.throws(
    () => transaction(() => execute()),
    /must own the outer transaction/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("writer lock exhaustion surfaces as a revision conflict", (t) => {
  const dbPath = openFixture(t);
  const blocker = createDbAdapter(new DatabaseSync(dbPath));
  blocker.exec("BEGIN IMMEDIATE");
  t.after(() => {
    blocker.exec("ROLLBACK");
    blocker.close();
  });
  _getAdapter()?.exec("PRAGMA busy_timeout = 1");

  assertErrorCode(
    () => execute(request({ idempotencyKey: "writer-contention" })),
    GSD_REVISION_CONFLICT,
    /writer contention/i,
  );
});

test("every pre-commit fault rolls back the operation, callback mutation, intents, and CAS", (t) => {
  openFixture(t);
  const faultPoints = [
    "after-operation",
    "after-mutation",
    "after-events",
    "after-outbox",
    "after-projections",
    "before-cas",
  ] as const;

  for (const point of faultPoints) {
    const before = durableSnapshot();
    _setDomainOperationFaultForTest(point);
    assert.throws(
      () => execute(request({ idempotencyKey: `fault/${point}` }), () => {
        const db = _getAdapter();
        assert.ok(db);
        db.prepare(`
          INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
          VALUES ('project', '', 'domain-operation-fault-probe', '{}', '2026-07-12T00:00:00.000Z')
        `).run();
        return mutation();
      }),
      new RegExp(point),
    );
    _setDomainOperationFaultForTest(null);
    assert.deepEqual(durableSnapshot(), before, `${point} left durable residue`);
  }
});

test("lost response after commit replays the original durable receipt", (t) => {
  openFixture(t);
  const operationRequest = request({ idempotencyKey: "lost-response" });
  _setDomainOperationFaultForTest("after-commit");
  assert.throws(() => execute(operationRequest), /after-commit/);
  _setDomainOperationFaultForTest(null);

  const committed = durableSnapshot();
  assert.equal((committed.authority as Record<string, unknown>).revision, 1);
  const replay = execute(operationRequest, () => {
    throw new Error("lost-response replay must not run mutation");
  });

  assert.equal(replay.status, "replayed");
  assert.equal(replay.resultingRevision, 1);
  assert.equal(replay.eventIds.length, 2);
  assert.equal(replay.outboxIds.length, 3);
  assert.equal(replay.projectionWorkIds.length, 1);
  assert.deepEqual(durableSnapshot(), committed);
});

test("successive operations supersede only the current projection head", (t) => {
  openFixture(t);
  const first = execute();
  const second = execute(
    request({ idempotencyKey: "transport/request-2", expectedRevision: 1, payload: { milestoneId: "M001", title: "Second" } }),
    () => mutation("status/project", "M001"),
  );

  assertCommittedReceipt(second, 2);
  assert.deepEqual(
    rows("SELECT projection_work_id, supersedes_projection_work_id, source_project_revision FROM workflow_projection_work ORDER BY source_project_revision"),
    [
      { projection_work_id: first.projectionWorkIds[0], supersedes_projection_work_id: null, source_project_revision: 1 },
      { projection_work_id: second.projectionWorkIds[0], supersedes_projection_work_id: first.projectionWorkIds[0], source_project_revision: 2 },
    ],
  );
});

test("projection receipt identities preserve mutation order", (t) => {
  openFixture(t);
  const result = execute(request({ idempotencyKey: "ordered-projections" }), () => ({
    events: mutation().events,
    projections: [
      { projectionKey: "status/project", projectionKind: "markdown", rendererVersion: "v1" },
      { projectionKey: "status/requirements", projectionKind: "markdown", rendererVersion: "v1" },
    ],
  }));

  assert.deepEqual(result.projectionWorkIds, [
    `${result.operationId}:0000`,
    `${result.operationId}:0001`,
  ]);
  assert.deepEqual(
    rows("SELECT projection_key FROM workflow_projection_work ORDER BY projection_work_id"),
    [{ projection_key: "status/project" }, { projection_key: "status/requirements" }],
  );
});

test("more than 10,000 projection targets are rejected without durable residue", (t) => {
  openFixture(t);
  const initial = durableSnapshot();
  const projections = Array.from({ length: 10_001 }, (_, index) => ({
    projectionKey: `status/generated-${String(index).padStart(5, "0")}`,
    projectionKind: "markdown",
    rendererVersion: "v1",
  }));

  assert.throws(
    () => execute(request({ idempotencyKey: "too-many-projections" }), () => ({
      events: mutation().events,
      projections,
    })),
    /projection.*(?:limit|10,?000|too many)/i,
  );
  assert.deepEqual(durableSnapshot(), initial);
});

test("callback mutation of operation provenance aborts the whole Domain Operation", (t) => {
  openFixture(t);
  const initial = durableSnapshot();

  for (const [column, value] of [
    ["request_hash", `sha256:${"0".repeat(64)}`],
    ["created_at", "2000-01-01T00:00:00.000Z"],
  ] as const) {
    assert.throws(
      () => execute(request({ idempotencyKey: `mutated-provenance/${column}` }), (context) => {
        const db = _getAdapter();
        assert.ok(db);
        db.prepare(`
          UPDATE workflow_operations
          SET ${column} = :value
          WHERE operation_id = :operation_id
        `).run({ ":value": value, ":operation_id": context.operationId });
        return mutation();
      }),
      /operation.*provenance/i,
    );
    assert.deepEqual(durableSnapshot(), initial);
  }
});

test("ordinary operations always retain the Authority Epoch", (t) => {
  openFixture(t);
  const ordinary = execute();
  assertCommittedReceipt(ordinary, 1, 0);

  const retained = execute(request({
    idempotencyKey: "transport/request-2",
    expectedRevision: 1,
    expectedAuthorityEpoch: 0,
    payload: { milestoneId: "M001", title: "After handoff" },
  }));
  assertCommittedReceipt(retained, 2, 0);
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 2,
    authority_epoch: 0,
  });
});

test("generic Domain Operation cannot select Authority Epoch advancement or invoke cutover", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const compileTimeBypass: DomainOperationRequest = {
    ...request({ idempotencyKey: "characterization/generic-epoch" }),
    // @ts-expect-error Authority Epoch advancement is not a generic request capability.
    advanceAuthorityEpoch: true,
  };

  assert.throws(
    () => execute(compileTimeBypass),
    /advanceAuthorityEpoch.*not accepted|typed authority cutover/i,
  );
  assert.throws(
    () => execute(request({
      operationType: "authority.cutover",
      idempotencyKey: "characterization/generic-cutover",
    })),
    /authority\.cutover.*typed|typed authority cutover/i,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("a restored v30 backup upgrades without inventing canonical history before its first operation", (t) => {
  const backupPath = createV30Backup();
  const restoredPath = join(dirname(backupPath), "restored-v30.db");
  copyFileSync(backupPath, restoredPath);

  assert.equal(openDatabase(restoredPath), true);
  t.after(closeDatabase);
  assert.equal(SCHEMA_VERSION, 50);
  assert.deepEqual(row("SELECT MAX(version) AS version FROM schema_version"), { version: 50 });
  assert.deepEqual(row("SELECT title, status FROM milestones WHERE id = 'M-LEGACY'"), {
    title: "Preserved from v30",
    status: "active",
  });
  assert.deepEqual(row("SELECT payload_json FROM audit_events WHERE event_id = 'audit-v30'"), {
    payload_json: '{"preserved":true}',
  });
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 0,
    authority_epoch: 0,
  });
  for (const table of [
    "workflow_operations",
    "workflow_domain_events",
    "workflow_outbox",
    "workflow_projection_work",
  ]) {
    assert.equal(row(`SELECT COUNT(*) AS count FROM ${table}`).count, 0, `${table} must begin empty`);
  }

  const result = execute(request({
    idempotencyKey: "restored-v30/first-operation",
    payload: { milestoneId: "M-LEGACY", title: "First canonical change" },
  }), () => mutation("status/project", "M-LEGACY"));

  assertCommittedReceipt(result, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_operations").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_domain_events").count, 2);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_outbox").count, 3);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_projection_work").count, 1);
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 1,
    authority_epoch: 0,
  });
  assert.deepEqual(row("SELECT title FROM milestones WHERE id = 'M-LEGACY'"), {
    title: "Preserved from v30",
  });
});

function runWriter(dbPath: string, id: string, startAt: number): Promise<Record<string, unknown>> {
  const dbHref = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts")).href;
  const operationHref = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/db/domain-operation.ts")).href;
  const script = `
    import { openDatabase, closeDatabase } from ${JSON.stringify(dbHref)};
    import { executeDomainOperation } from ${JSON.stringify(operationHref)};
    const [dbPath, id, startAt] = process.argv.slice(1);
    if (!openDatabase(dbPath)) throw new Error('database open failed');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(startAt) - Date.now()));
    try {
      const result = executeDomainOperation({
        operationType: 'race', idempotencyKey: 'race/' + id,
        expectedRevision: 0, expectedAuthorityEpoch: 0,
        actorType: 'agent', actorId: id, sourceTransport: 'process',
        payload: { id },
      }, () => ({
        events: [{ eventType: 'race.won', entityType: 'project', entityId: id, payload: { id }, destinations: ['projection'] }],
        projections: [{ projectionKey: 'race/' + id, projectionKind: 'markdown', rendererVersion: 'v1' }],
      }));
      console.log(JSON.stringify({ kind: 'result', status: result.status, operationId: result.operationId }));
    } catch (error) {
      console.log(JSON.stringify({ kind: 'error', message: String(error?.message ?? error), code: error?.code ?? null }));
    } finally { closeDatabase(); }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "./src/resources/extensions/gsd/tests/resolve-ts.mjs",
      "--experimental-strip-types", "--input-type=module", "-e", script,
      dbPath, id, String(startAt),
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `writer exited ${code}`));
      try { resolve(JSON.parse(stdout.trim()) as Record<string, unknown>); }
      catch { reject(new Error(`invalid writer output: ${stdout}\n${stderr}`)); }
    });
  });
}

test("two real processes racing one expected tuple yield one commit and one stale result", async (t) => {
  const dbPath = openFixture(t);
  closeDatabase();
  const startAt = Date.now() + 1_000;
  const outcomes = await Promise.all([
    runWriter(dbPath, "writer-a", startAt),
    runWriter(dbPath, "writer-b", startAt),
  ]);

  const committed = outcomes.filter((outcome) => outcome.kind === "result");
  const rejected = outcomes.filter((outcome) => outcome.kind === "error");
  assert.equal(committed.length, 1, JSON.stringify(outcomes));
  assert.equal(rejected.length, 1, JSON.stringify(outcomes));
  assert.equal(rejected[0]?.code, GSD_REVISION_CONFLICT);
  assert.match(String(rejected[0]?.message), /stale project revision/i);
  assert.doesNotMatch(String(rejected[0]?.message), /SQLITE_BUSY|database is locked/i);

  assert.equal(openDatabase(dbPath), true);
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 1,
    authority_epoch: 0,
  });
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_operations").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_domain_events").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_outbox").count, 1);
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_projection_work").count, 1);
});

test("receipt component verification accepts the import.apply and authority.cutover stored hashes", (t) => {
  openFixture(t);

  // import.apply durably stores the sealed Preview hash as request_hash, not
  // the conventional requestHash(request) — verification must recompute the
  // operation-type-appropriate stored hash or it rejects every import receipt.
  const preview = importPreview();
  const applyRequest = importRequest(preview);
  const applyMutation = mutation();
  const applied = executeImportDomainOperation(applyRequest, (context) => {
    insertImportApplication(context, preview);
    return applyMutation;
  });
  assert.equal(applied.requestHash, preview.preview_hash);
  assertDomainOperationReceiptComponents(
    applied,
    applyRequest as unknown as DomainOperationRequest,
    applyMutation,
  );

  // authority.cutover durably stores the epoch-advancing request hash, while
  // the assert path used to recompute unconditionally with
  // advanceAuthorityEpoch=false and reject every cutover receipt.
  const evidenceHash = `sha256:${"3".repeat(64)}`;
  const consentHash = `sha256:${"4".repeat(64)}`;
  const cutoverRequest: AuthorityCutoverDomainOperationRequest = {
    operationType: "authority.cutover",
    idempotencyKey: "cutover/receipt-components",
    expectedRevision: 1,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    actorId: "authority-cutover",
    sourceTransport: "internal",
    payload: {
      authorityContractVersion: 1,
      evidenceHash,
      consentHash,
    },
  };
  const cutoverMutation = mutation();
  const cutover = _executeAuthorityCutoverDomainOperation(cutoverRequest, (context) => {
    insertAuthorityCutoverReceipt(context, {
      authorityContractVersion: 1,
      evidenceHash,
      consentHash,
    });
    return cutoverMutation;
  });
  assert.equal(cutover.resultingAuthorityEpoch, 1);
  assertDomainOperationReceiptComponents(cutover, cutoverRequest, cutoverMutation);
});

test("receipt component verification still rejects request identity drift", (t) => {
  openFixture(t);
  const preview = importPreview();
  const applyRequest = importRequest(preview);
  const applied = executeImportDomainOperation(applyRequest, (context) => {
    insertImportApplication(context, preview);
    return mutation();
  });

  assert.throws(
    () => assertDomainOperationReceiptComponents(
      applied,
      {
        ...applyRequest,
        idempotencyKey: "legacy-import/application-drifted",
      } as unknown as DomainOperationRequest,
      mutation(),
    ),
    /receipt components or header are incomplete or corrupt/,
  );
  assert.throws(
    () => assertDomainOperationReceiptComponents(
      applied,
      { ...applyRequest, payload: {} } as unknown as DomainOperationRequest,
      mutation(),
    ),
    /sealed Preview artifact|receipt components or header/i,
  );
});
