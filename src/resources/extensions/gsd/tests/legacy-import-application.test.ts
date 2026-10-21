// Project/App: gsd-pi
// File Purpose: Public integration proof for transactional legacy Import Application.

import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  prepareLegacyImportBackup,
  sealLegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import type { LegacyImportApplicationPlan } from "../legacy-import-application-plan.ts";
import {
  compileLegacyImportApplicationPlan,
  legacyImportProjectionKind,
} from "../legacy-import-application-plan.ts";
import * as applicationModule from "../legacy-import-application.ts";
import {
  LegacyImportApplicationError,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
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
import { type DbAdapter } from "../db-adapter.ts";
import {
  executeDomainOperation,
  type DomainOperationResult,
} from "../db/domain-operation.ts";
import {
  adoptLifecycleIfMissing,
  adoptOrTransitionLifecycle,
} from "../db/writers/lifecycle-commands.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();
let applicationSequence = 0;

type ApplyLegacyImport = (input: unknown) => LegacyImportApplicationReceipt;

interface PreparedApplicationCase {
  source: string;
  databasePath: string;
  base: LegacyImportBaseSnapshot;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
  input: LegacyImportApplicationInput;
  plan: LegacyImportApplicationPlan;
}

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, params?: Record<string, unknown>): Array<Record<string, unknown>> {
  const statement = db().prepare(sql);
  return (params === undefined ? statement.all() : statement.all(params)) as Array<Record<string, unknown>>;
}

function row(sql: string, params?: Record<string, unknown>): Record<string, unknown> {
  const statement = db().prepare(sql);
  return (params === undefined ? statement.get() : statement.get(params)) ?? {};
}

function getApplyLegacyImport(): ApplyLegacyImport {
  const candidate = (applicationModule as unknown as Record<string, unknown>)["applyLegacyImport"];
  assert.equal(
    typeof candidate,
    "function",
    "applyLegacyImport public Application boundary is missing",
  );
  return candidate as ApplyLegacyImport;
}

function prepareCase(
  caseName: "gsd-nested" | "custom-workflow",
  seed?: () => void,
  mutateSource?: (sourceDirectory: string) => void,
): PreparedApplicationCase {
  applicationSequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), `gsd-legacy-application-${caseName}-`));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const destination = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, caseName, "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(destination);
  mutateSource?.(source);
  assert.equal(openDatabase(databasePath), true);
  seed?.();
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  assert.equal(preview.preview.base_project_revision, base.authority.revision);
  assert.equal(preview.preview.base_authority_epoch, base.authority.authority_epoch);
  assert.equal(preview.preview.base_database_schema_version, base.database_schema_version);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: destination,
    label: "pre-application",
  });
  assert.equal(backup.project_id, base.authority.project_id);
  assert.equal(backup.project_root_realpath, base.authority.project_root_realpath);
  assert.equal(backup.relevant_rows_hash, base.relevant_rows_hash);
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/application-${applicationSequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-application-test",
      traceId: `application-trace-${applicationSequence}`,
      turnId: `application-turn-${applicationSequence}`,
    },
    previewInput,
    preview,
    backup,
  };
  return {
    source,
    databasePath,
    base,
    preview,
    backup,
    input,
    plan: compileLegacyImportApplicationPlan(preview),
  };
}

function applicationSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority ORDER BY singleton"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    dependencies: rows("SELECT * FROM slice_dependencies ORDER BY milestone_id, slice_id, depends_on_slice_id"),
    requirements: rows("SELECT * FROM requirements ORDER BY id"),
    decisions: rows("SELECT * FROM decisions ORDER BY id"),
    memories: rows("SELECT * FROM memories ORDER BY seq"),
    artifacts: rows("SELECT * FROM artifacts ORDER BY path"),
    assessments: rows("SELECT * FROM assessments ORDER BY path"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY attempt_id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    applications: rows("SELECT * FROM workflow_import_applications ORDER BY resulting_project_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY projection_work_id"),
  };
}

function canonicalRowsSnapshot(): Record<string, unknown> {
  return {
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    dependencies: rows("SELECT * FROM slice_dependencies ORDER BY milestone_id, slice_id, depends_on_slice_id"),
    requirements: rows("SELECT * FROM requirements ORDER BY id"),
    decisions: rows("SELECT * FROM decisions ORDER BY id"),
    memories: rows("SELECT * FROM memories ORDER BY seq"),
    artifacts: rows("SELECT * FROM artifacts ORDER BY path"),
    assessments: rows("SELECT * FROM assessments ORDER BY path"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
  };
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function expectedInstructionResults(prepared: PreparedApplicationCase): Array<Record<string, unknown>> {
  return prepared.plan.instructions.map((instruction) => {
    const identity = {
      action: instruction.action,
      targetKind: instruction.targetKind,
      targetIdentityHash: hashLegacyImportValue({
        kind: instruction.targetKind,
        key: instruction.targetKey,
      }),
    };
    if (instruction.action === "replace-slice-dependencies") {
      const deleted = prepared.base.rows.filter((row) => row.row_set === "slice_dependencies"
        && row.value["milestone_id"] === instruction.milestoneId
        && row.value["slice_id"] === instruction.sliceId).length;
      return {
        ...identity,
        expectedAffectedRows: instruction.dependsOnSliceIds.length,
        affectedRows: deleted + instruction.dependsOnSliceIds.length,
      };
    }
    if (instruction.action === "delete-slice-dependencies") {
      const deleted = prepared.base.rows.filter((row) => row.row_set === "slice_dependencies"
        && row.value["milestone_id"] === instruction.milestoneId
        && (row.value["slice_id"] === instruction.sliceId
          || row.value["depends_on_slice_id"] === instruction.sliceId)).length;
      return { ...identity, expectedAffectedRows: 0, affectedRows: deleted };
    }
    if (instruction.action === "preserve") {
      return { ...identity, expectedAffectedRows: 0, affectedRows: 0 };
    }
    return { ...identity, expectedAffectedRows: 1, affectedRows: 1 };
  });
}

function expectedEventPayload(prepared: PreparedApplicationCase): Record<string, unknown> {
  const identity = createLegacyImportApplicationIdentity(prepared.input);
  return {
    replayIdentitySchemaVersion: identity.replayIdentity.replayIdentitySchemaVersion,
    applicationIdentityHash: identity.applicationIdentityHash,
    previewInputHash: identity.replayIdentity.previewInputHash,
    backupArtifactHash: hashLegacyImportValue(prepared.backup),
    backupId: prepared.backup.backup_id,
    applicationRelevantRowsHash: captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash,
    planSchemaVersion: prepared.plan.planSchemaVersion,
    eventFacts: prepared.plan.eventFacts,
    projectionKeys: prepared.plan.projectionKeys,
    instructionResults: expectedInstructionResults(prepared),
  };
}

function assertStoredAggregate(
  prepared: PreparedApplicationCase,
  result: LegacyImportApplicationReceipt,
): void {
  const operation = row(`SELECT * FROM workflow_operations WHERE operation_id = :operation_id`, {
    ":operation_id": result.operationId,
  });
  const application = row(`SELECT * FROM workflow_import_applications WHERE operation_id = :operation_id`, {
    ":operation_id": result.operationId,
  });
  const events = rows(`SELECT * FROM workflow_domain_events WHERE operation_id = :operation_id ORDER BY event_index`, {
    ":operation_id": result.operationId,
  });
  assert.equal(operation["operation_type"], "import.apply");
  assert.equal(operation["request_hash"], prepared.preview.preview_hash);
  assert.equal(operation["expected_revision"], prepared.base.authority.revision);
  assert.equal(operation["resulting_revision"], prepared.base.authority.revision + 1);
  assert.equal(operation["expected_authority_epoch"], prepared.base.authority.authority_epoch);
  assert.equal(operation["resulting_authority_epoch"], prepared.base.authority.authority_epoch);
  assert.equal(application["preview_json"], canonicalLegacyImportJson(prepared.preview.preview));
  assert.equal(application["preview_hash"], prepared.preview.preview_hash);
  assert.equal(application["backup_ref"], prepared.backup.backup_ref);
  assert.equal(application["backup_sha256"], prepared.backup.backup_sha256);
  assert.equal(application["backup_byte_size"], prepared.backup.backup_byte_size);
  assert.equal(application["resulting_project_revision"], prepared.base.authority.revision + 1);
  assert.equal(application["resulting_authority_epoch"], prepared.base.authority.authority_epoch);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.["event_type"], "legacy-import.applied");
  assert.equal(events[0]?.["entity_type"], "legacy-import");
  assert.equal(events[0]?.["entity_id"], prepared.preview.preview.preview_id);
  assert.equal(events[0]?.["project_revision"], prepared.base.authority.revision + 1);
  assert.equal(events[0]?.["authority_epoch"], prepared.base.authority.authority_epoch);
  assert.deepEqual(JSON.parse(String(events[0]?.["payload_json"])), expectedEventPayload(prepared));

  const outbox = rows(`SELECT outbox.outbox_id, outbox.event_id, outbox.destination
    FROM workflow_outbox outbox
    JOIN workflow_domain_events event ON event.event_id = outbox.event_id
    WHERE event.operation_id = :operation_id
    ORDER BY outbox.outbox_id`, { ":operation_id": result.operationId });
  assert.deepEqual(outbox, [{
    outbox_id: result.outboxIds[0],
    event_id: result.eventIds[0],
    destination: "projection",
  }]);
  const projections = rows(`SELECT projection_work_id, projection_key, projection_kind,
      renderer_version, source_project_revision, source_authority_epoch,
      enqueue_operation_id, delivery_state
    FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id
    ORDER BY projection_work_id`, { ":operation_id": result.operationId });
  assert.deepEqual(projections, prepared.plan.projectionKeys.map((projectionKey, index) => ({
    projection_work_id: result.projectionWorkIds[index],
    projection_key: projectionKey,
    projection_kind: legacyImportProjectionKind(projectionKey),
    renderer_version: "v1",
    source_project_revision: prepared.base.authority.revision + 1,
    source_authority_epoch: prepared.base.authority.authority_epoch,
    enqueue_operation_id: result.operationId,
    delivery_state: "pending",
  })));
}

function assertCommittedResult(
  prepared: PreparedApplicationCase,
  result: LegacyImportApplicationReceipt,
): void {
  const identity = createLegacyImportApplicationIdentity(prepared.input);
  const application = row(`SELECT applied_at FROM workflow_import_applications WHERE operation_id = :operation_id`, {
    ":operation_id": result.operationId,
  });
  assert.deepEqual(result, {
    status: "committed",
    operationId: result.operationId,
    projectId: prepared.base.authority.project_id,
    applicationIdentityHash: identity.applicationIdentityHash,
    previewId: prepared.preview.preview.preview_id,
    previewHash: prepared.preview.preview_hash,
    backupId: prepared.backup.backup_id,
    baseProjectRevision: prepared.base.authority.revision,
    baseAuthorityEpoch: prepared.base.authority.authority_epoch,
    resultingRevision: prepared.base.authority.revision + 1,
    resultingAuthorityEpoch: prepared.base.authority.authority_epoch,
    appliedAt: application["applied_at"],
    eventIds: result.eventIds,
    outboxIds: result.outboxIds,
    projectionWorkIds: result.projectionWorkIds,
  });
  assert.equal(result.eventIds.length, 1);
  assert.equal(result.outboxIds.length, 1);
  assert.equal(result.projectionWorkIds.length, prepared.plan.projectionKeys.length);
  assertDeepFrozen(result);
}

function expectApplicationError(
  fn: () => unknown,
  expected: {
    stage: LegacyImportApplicationError["stage"];
    code: LegacyImportApplicationError["code"];
    retryable: boolean;
  },
  forbiddenPaths: readonly string[] = [],
): LegacyImportApplicationError {
  let observed: unknown;
  try {
    fn();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError);
  assert.equal(observed.stage, expected.stage);
  assert.equal(observed.code, expected.code);
  assert.equal(observed.retryable, expected.retryable);
  assertDeepFrozen(observed.context);
  const publicFailure = `${observed.message}\n${JSON.stringify(observed.context)}`;
  for (const forbiddenPath of forbiddenPaths) assert.equal(publicFailure.includes(forbiddenPath), false);
  return observed;
}

function firstRegularFile(directory: string): string {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile()) return path;
    if (entry.isDirectory()) {
      try {
        return firstRegularFile(path);
      } catch {
        // Continue to the next branch.
      }
    }
  }
  throw new Error("fixture has no regular file");
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function seedHierarchy(): void {
  db().exec(`
    INSERT INTO milestones (id, title, status) VALUES ('M999', 'Coordination fixture', 'active');
    INSERT INTO slices (milestone_id, id, title, status)
      VALUES ('M999', 'S99', 'Coordination slice', 'pending');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
      VALUES ('M999', 'S99', 'T99', 'Coordination task', 'pending');
  `);
}

function seedWorker(workerId: string, status: "active" | "stopping" | "crashed"): void {
  const projectRoot = String(row(
    "SELECT project_root_realpath FROM project_authority WHERE singleton = 1",
  )["project_root_realpath"]);
  db().prepare(`INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      :worker_id, 'test-host', 999, '1970-01-01T00:00:00.000Z', 'test',
      '1970-01-01T00:00:00.000Z', :status, :project_root_realpath
    )`).run({
    ":worker_id": workerId,
    ":status": status,
    ":project_root_realpath": projectRoot,
  });
}

function seedLease(
  workerId: string,
  status: "held" | "released" | "expired",
  expiresAt = "1970-01-01T00:00:00.000Z",
): void {
  db().prepare(`INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M999', :worker_id, 1, '1970-01-01T00:00:00.000Z',
      :expires_at, :status
    )`).run({
    ":worker_id": workerId,
    ":expires_at": expiresAt,
    ":status": status,
  });
}

function seedDispatch(
  workerId: string,
  status: "claimed" | "running" | "completed" | "failed" | "canceled",
  sequence: number,
  unitId = `M999/S99/T99/${sequence}`,
): void {
  const terminal = status === "claimed" || status === "running" ? null : "1970-01-01T00:01:00.000Z";
  db().prepare(`INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at, ended_at
    ) VALUES (
      :trace_id, :turn_id, :worker_id, 1,
      'M999', 'S99', 'T99', 'execute-task', :unit_id,
      :status, 1, '1970-01-01T00:00:00.000Z', :ended_at
    )`).run({
    ":trace_id": `coordination-dispatch-trace-${sequence}`,
    ":turn_id": `coordination-dispatch-turn-${sequence}`,
    ":worker_id": workerId,
    ":unit_id": unitId,
    ":status": status,
    ":ended_at": terminal,
  });
}

function operationFence(): { revision: number; authorityEpoch: number } {
  const authority = row(
    "SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1",
  );
  return {
    revision: Number(authority["revision"]),
    authorityEpoch: Number(authority["authority_epoch"]),
  };
}

function executeFixtureOperation(
  operationType: string,
  mutate?: Parameters<typeof executeDomainOperation>[1],
): DomainOperationResult {
  applicationSequence += 1;
  const fence = operationFence();
  return executeDomainOperation({
    operationType,
    idempotencyKey: `legacy-import/coordination-fixture-${applicationSequence}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { fixture: operationType },
  }, mutate ?? (() => ({
    events: [{
      eventType: operationType,
      entityType: "task",
      entityId: "M999/S99/T99",
      payload: { fixture: operationType },
      destinations: ["test"],
    }],
    projections: [{
      projectionKey: `test/${operationType.replaceAll(".", "/")}`,
      projectionKind: "test",
      rendererVersion: "1",
    }],
  })));
}

function seedAttempt(state: "claimed" | "running" | "settled"): void {
  if (state === "settled") {
    seedSettledAttempt();
    return;
  }
  seedHierarchy();
  let lifecycleId = "";
  const claimOperation = executeFixtureOperation("test.coordination.claim", (context) => {
    const lifecycle = adoptLifecycleIfMissing(context, {
      itemKind: "task",
      milestoneId: "M999",
      sliceId: "S99",
      taskId: "T99",
      lifecycleStatus: "pending",
      occurredAt: "1970-01-01T00:00:00.000Z",
    });
    lifecycleId = lifecycle.lifecycleId;
    return {
      events: [{
        eventType: "test.coordination.claim",
        entityType: "task",
        entityId: "M999/S99/T99",
        payload: { lifecycleId },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/coordination/claim",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  assert.notEqual(lifecycleId, "");
  if (state === "running") {
    seedWorker("attempt-worker", "active");
    seedLease("attempt-worker", "held", "2099-01-01T00:00:00.000Z");
  }
  db().prepare(`INSERT INTO workflow_execution_attempts (
      attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
      attempt_state, coordination_dispatch_id, worker_id, milestone_lease_token,
      claimed_at, started_at, ended_at,
      claim_operation_id, claim_project_revision, claim_authority_epoch
    ) VALUES (
      'attempt-1', :project_id, :lifecycle_id, 1, NULL,
      'claimed', NULL, :worker_id, :lease_token,
      '1970-01-01T00:00:00.000Z', NULL, NULL,
      :claim_operation_id, :claim_project_revision, :claim_authority_epoch
    )`).run({
    ":project_id": claimOperation.projectId,
    ":lifecycle_id": lifecycleId,
    ":worker_id": state === "running" ? "attempt-worker" : null,
    ":lease_token": state === "running" ? 1 : null,
    ":claim_operation_id": claimOperation.operationId,
    ":claim_project_revision": claimOperation.resultingRevision,
    ":claim_authority_epoch": claimOperation.resultingAuthorityEpoch,
  });
  if (state === "running") {
    db().prepare(`UPDATE workflow_execution_attempts
      SET attempt_state = 'running', started_at = '1970-01-01T00:00:01.000Z'
      WHERE attempt_id = 'attempt-1'`).run();
    db().prepare("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M999'").run();
    db().prepare("UPDATE workers SET status = 'stopping' WHERE worker_id = 'attempt-worker'").run();
  }
}

function seedSettledAttempt(): void {
  seedHierarchy();
  seedWorker("settled-attempt-worker", "active");
  seedLease("settled-attempt-worker", "held", "2099-01-01T00:00:00.000Z");
  seedDispatch("settled-attempt-worker", "claimed", 99, "M999/S99/T99");
  executeFixtureOperation("test.coordination.ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M999",
      sliceId: "S99",
      taskId: "T99",
      lifecycleStatus: "ready",
      occurredAt: "1970-01-01T00:00:00.000Z",
    });
    return {
      events: [{
        eventType: "test.coordination.ready",
        entityType: "task",
        entityId: "M999/S99/T99",
        payload: { status: "ready" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/coordination/ready",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchId = Number(row(
    "SELECT id FROM unit_dispatches WHERE unit_id = 'M999/S99/T99'",
  )["id"]);
  const invocation = {
    idempotencyKey: `legacy-import/settled-attempt-${applicationSequence += 1}`,
    sourceTransport: "internal" as const,
    actorType: "test",
    actorId: "legacy-import-application-test",
    traceId: "settled-attempt-trace",
    turnId: "settled-attempt-turn",
  };
  const claimed = claimTaskAttempt({
    invocation,
    task: { milestoneId: "M999", sliceId: "S99", taskId: "T99" },
    workerId: "settled-attempt-worker",
    milestoneLeaseToken: 1,
    coordinationDispatchId: dispatchId,
  });
  settleTaskAttempt({
    invocation: { ...invocation, idempotencyKey: `${invocation.idempotencyKey}/settle` },
    attemptId: claimed.attemptId,
    outcome: "failed",
    failureClass: "test-terminal",
    summary: "schema-safe terminal Attempt fixture",
    output: {},
  });
  db().prepare("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M999'").run();
  db().prepare("UPDATE workers SET status = 'stopping' WHERE worker_id = 'settled-attempt-worker'").run();
}

function assertCoordinationBlocked(
  prepared: PreparedApplicationCase,
  expectedContext: Readonly<Record<string, number>>,
): void {
  const applyLegacyImport = getApplyLegacyImport();
  const before = applicationSnapshot();
  const error = expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "coordination",
    code: "LEGACY_IMPORT_APPLICATION_COORDINATION_ACTIVE",
    retryable: true,
  }, [prepared.source, prepared.backup.backup_ref]);
  for (const [field, expected] of Object.entries(expectedContext)) {
    assert.equal(error.context[field], expected);
  }
  assert.deepEqual(applicationSnapshot(), before);
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("public Application commits one real mutating Preview with exact durable output", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("gsd-nested");
  const beforeCanonical = canonicalRowsSnapshot();
  assert.ok(prepared.plan.instructions.some((instruction) => instruction.action !== "preserve"));

  const result = applyLegacyImport(prepared.input);

  assertCommittedResult(prepared, result);
  assertStoredAggregate(prepared, result);
  assert.notDeepEqual(canonicalRowsSnapshot(), beforeCanonical);
  for (const instruction of prepared.plan.instructions) {
    if (instruction.action !== "create") continue;
    if (instruction.targetKind === "milestone") {
      assert.equal(row("SELECT COUNT(*) AS count FROM milestones WHERE id = :id", {
        ":id": instruction.identity["id"],
      })["count"], 1);
    } else if (instruction.targetKind === "slice") {
      assert.equal(row(`SELECT COUNT(*) AS count FROM slices
        WHERE milestone_id = :milestone_id AND id = :id`, {
        ":milestone_id": instruction.identity["milestone_id"],
        ":id": instruction.identity["id"],
      })["count"], 1);
    } else if (instruction.targetKind === "task") {
      assert.equal(row(`SELECT COUNT(*) AS count FROM tasks
        WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`, {
        ":milestone_id": instruction.identity["milestone_id"],
        ":slice_id": instruction.identity["slice_id"],
        ":id": instruction.identity["id"],
      })["count"], 1);
    }
  }
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1"), {
    revision: prepared.base.authority.revision + 1,
    authority_epoch: prepared.base.authority.authority_epoch,
  });
});

test("Application persists per-task Verification, Inputs, and Expected Output from a nested slice plan", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("gsd-nested", undefined, (source) => {
    appendFileSync(
      join(source, ".gsd", "milestones", "M001-foundation", "slices", "S01-core", "S01-PLAN.md"),
      [
        "",
        "### T01: Create the project skeleton",
        "",
        "Inputs:",
        "- `src/skeleton.js`",
        "- `test/skeleton.test.js`",
        "",
        "Expected Output:",
        "- `src/skeleton.js` — module skeleton exists",
        "",
        "Verification:",
        "- `node --test test/skeleton.test.js`",
        "",
      ].join("\n"),
    );
  });

  applyLegacyImport(prepared.input);

  assert.deepEqual(row(`SELECT verify, inputs, expected_output FROM tasks
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'`), {
    verify: "node --test test/skeleton.test.js",
    inputs: "[\"src/skeleton.js\",\"test/skeleton.test.js\"]",
    expected_output: "[\"src/skeleton.js — module skeleton exists\"]",
  });
});

test("preserve-only Application commits its durable disposition without promoting legacy authority", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  const beforeCanonical = canonicalRowsSnapshot();
  assert.equal(prepared.preview.preview.counts.preserve, 18);
  assert.ok(prepared.plan.instructions.every((instruction) => instruction.action === "preserve"));

  const result = applyLegacyImport(prepared.input);

  assertCommittedResult(prepared, result);
  assertStoredAggregate(prepared, result);
  assert.deepEqual(canonicalRowsSnapshot(), beforeCanonical);
  assert.deepEqual(row(`SELECT create_count, update_count, delete_count, preserve_count,
      unparsed_count, unresolved_count
    FROM workflow_import_applications`), {
    create_count: 0,
    update_count: 0,
    delete_count: 0,
    preserve_count: 18,
    unparsed_count: prepared.preview.preview.counts.unparsed,
    unresolved_count: 0,
  });
  assert.deepEqual(rows("SELECT projection_key FROM workflow_projection_work ORDER BY projection_key"), [{
    projection_key: `legacy-import/${prepared.preview.preview.preview_id}`,
  }]);
});

test("exact replay survives restart after every source and backup file disappears", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  const committed = applyLegacyImport(prepared.input);
  const durable = applicationSnapshot();
  closeDatabase();
  rmSync(prepared.source, { recursive: true, force: true });
  rmSync(prepared.backup.backup_ref, { force: true });
  assert.equal(openDatabase(prepared.databasePath), true);

  const replayed = applyLegacyImport(structuredClone(prepared.input));

  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  assertDeepFrozen(replayed);
  assert.deepEqual(applicationSnapshot(), durable);
});

test("changed replay identity conflicts before consulting missing source or backup files", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  applyLegacyImport(prepared.input);
  const durable = applicationSnapshot();
  closeDatabase();
  rmSync(prepared.source, { recursive: true, force: true });
  rmSync(prepared.backup.backup_ref, { force: true });
  assert.equal(openDatabase(prepared.databasePath), true);
  const relocated = sealLegacyImportVerifiedBackup({
    preview: prepared.preview,
    base: prepared.base,
    backup_ref: `${prepared.backup.backup_ref}.relocated`,
    backup_sha256: prepared.backup.backup_sha256,
    backup_byte_size: prepared.backup.backup_byte_size,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: new Date(Date.parse(prepared.backup.verified_at) + 1_000).toISOString(),
  });
  assert.equal(relocated.backup_id, prepared.backup.backup_id);
  assert.notEqual(hashLegacyImportValue(relocated), hashLegacyImportValue(prepared.backup));
  const conflicts: LegacyImportApplicationInput[] = [
    {
      ...prepared.input,
      invocation: { ...prepared.input.invocation, actorId: "changed-actor" },
    },
    {
      ...prepared.input,
      previewInput: { ...prepared.input.previewInput, bundledDefinitionNames: ["changed"] },
    },
    { ...prepared.input, backup: relocated },
    {
      ...prepared.input,
      invocation: { ...prepared.input.invocation, idempotencyKey: "different-key-same-preview" },
    },
  ];

  for (const conflict of conflicts) {
    expectApplicationError(() => applyLegacyImport(conflict), {
      stage: "replay",
      code: "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT",
      retryable: false,
    }, [prepared.source, prepared.backup.backup_ref]);
    assert.deepEqual(applicationSnapshot(), durable);
  }
});

test("fresh source drift fails with a typed Preview error and zero database residue", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  appendFileSync(firstRegularFile(prepared.source), "\nchanged after approval\n", "utf8");
  const before = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "preview",
    code: "LEGACY_IMPORT_APPLICATION_PREVIEW_CHANGED",
    retryable: true,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), before);
});

test("a missing required source is normalized to a safe public Preview-changed error", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  rmSync(prepared.source, { recursive: true, force: true });
  const before = applicationSnapshot();

  const error = expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "preview",
    code: "LEGACY_IMPORT_APPLICATION_PREVIEW_CHANGED",
    retryable: true,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.equal(error.context["cause_code"], "LEGACY_IMPORT_SOURCE_UNAVAILABLE");
  assert.deepEqual(applicationSnapshot(), before);
});

test("receipt is inserted after canonical siblings and before event, outbox, and projection work", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("gsd-nested");
  const milestone = prepared.plan.instructions.find((instruction) => (
    instruction.action === "create" && instruction.targetKind === "milestone"
  ));
  assert.ok(milestone && milestone.action === "create");
  const milestoneId = String(milestone.identity["id"]);
  db().exec(`CREATE TRIGGER test_legacy_import_receipt_order
    BEFORE INSERT ON workflow_import_applications
    WHEN NOT EXISTS (SELECT 1 FROM milestones WHERE id = ${sqlText(milestoneId)})
      OR EXISTS (SELECT 1 FROM workflow_domain_events WHERE operation_id = NEW.operation_id)
      OR EXISTS (SELECT 1 FROM workflow_projection_work WHERE enqueue_operation_id = NEW.operation_id)
    BEGIN
      SELECT RAISE(ABORT, 'receipt inserted outside the required sibling-write boundary');
    END`);

  const result = applyLegacyImport(prepared.input);

  assertCommittedResult(prepared, result);
  assertStoredAggregate(prepared, result);
});

test("receipt insertion failure rolls every sibling write back", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("gsd-nested");
  db().exec(`CREATE TRIGGER test_legacy_import_receipt_abort
    BEFORE INSERT ON workflow_import_applications
    BEGIN
      SELECT RAISE(ABORT, 'injected receipt failure');
    END`);
  const before = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "receipt",
    code: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), before);
});

test("receipt strict-validation failure is public receipt inconsistency and rolls back", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("gsd-nested");
  const tamperedRequestHash = hashLegacyImportValue("tampered after canonical sibling write");
  db().exec(`CREATE TRIGGER test_legacy_import_receipt_strict_validation
    AFTER INSERT ON milestones
    WHEN NEW.id != 'M998'
    BEGIN
      UPDATE workflow_operations
      SET request_hash = ${sqlText(tamperedRequestHash)}
      WHERE operation_type = 'import.apply';
    END`);
  const before = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "receipt",
    code: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), before);
});

test("backup artifact drift after preparation fails closed with zero residue", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  appendFileSync(prepared.backup.backup_ref, "changed after verification", "utf8");
  const before = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "backup",
    code: "LEGACY_IMPORT_APPLICATION_BACKUP_CHANGED",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), before);
});

test("missing already-verified backup is typed as changed and leaves zero residue", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  rmSync(prepared.backup.backup_ref, { force: true });
  const before = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "backup",
    code: "LEGACY_IMPORT_APPLICATION_BACKUP_CHANGED",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), before);
});

test("replay rejects a durable event whose timestamp was tampered", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  applyLegacyImport(prepared.input);
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  db().prepare(`UPDATE workflow_domain_events
    SET created_at = '1970-01-01T00:00:00.000Z'
    WHERE event_type = 'legacy-import.applied'`).run();
  const beforeReplay = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "receipt",
    code: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), beforeReplay);
});

test("replay treats a missing durable Application receipt as inconsistent", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  const committed = applyLegacyImport(prepared.input);
  db().exec("DROP TRIGGER trg_workflow_import_application_delete");
  db().prepare(
    "DELETE FROM workflow_import_applications WHERE operation_id = :operation_id",
  ).run({ ":operation_id": committed.operationId });
  const beforeReplay = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "receipt",
    code: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), beforeReplay);
});

test("replay treats a tampered Application receipt scalar as inconsistent", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  const committed = applyLegacyImport(prepared.input);
  const eventPayload = row(`SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id`, {
    ":operation_id": committed.operationId,
  })["payload_json"];
  db().exec("DROP TRIGGER trg_workflow_import_application_update");
  db().prepare(`UPDATE workflow_import_applications
    SET backup_verified_at = '1970-01-01T00:00:00.000Z'
    WHERE operation_id = :operation_id`).run({ ":operation_id": committed.operationId });
  assert.equal(row(`SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id`, {
    ":operation_id": committed.operationId,
  })["payload_json"], eventPayload);
  const beforeReplay = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "receipt",
    code: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), beforeReplay);
});

test("a missing canonical authority is a safe stale-transaction error", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  db().prepare("DELETE FROM project_authority WHERE singleton = 1").run();
  const before = applicationSnapshot();

  const error = expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "transaction",
    code: "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.equal(error.context["cause_code"], "LEGACY_IMPORT_BASE_AUTHORITY_MISSING");
  assert.deepEqual(applicationSnapshot(), before);
});

test("replay rejects projection work whose immutable timestamp was tampered", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  const committed = applyLegacyImport(prepared.input);
  db().exec(`DROP TRIGGER trg_workflow_projection_identity_immutable;
    DROP TRIGGER trg_workflow_projection_delivery_transition`);
  db().prepare(`UPDATE workflow_projection_work
    SET created_at = '1970-01-01T00:00:00.000Z'
    WHERE enqueue_operation_id = :operation_id`).run({ ":operation_id": committed.operationId });
  const beforeReplay = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "receipt",
    code: "LEGACY_IMPORT_APPLICATION_RECEIPT_INCONSISTENT",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), beforeReplay);
});

test("relevant canonical base drift without an authority increment is stale and leaves no Application residue", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow");
  db().exec(`CREATE TRIGGER test_legacy_import_transactional_base_drift
    AFTER INSERT ON workflow_operations
    WHEN NEW.operation_type = 'import.apply'
    BEGIN
      INSERT INTO milestones (id, title, status)
      VALUES ('M998', 'Unversioned concurrent drift', 'pending');
    END`);
  const before = applicationSnapshot();

  expectApplicationError(() => applyLegacyImport(prepared.input), {
    stage: "transaction",
    code: "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
    retryable: false,
  }, [prepared.source, prepared.backup.backup_ref]);
  assert.deepEqual(applicationSnapshot(), before);
});

test("an active worker blocks by status even with an expired heartbeat", () => {
  const prepared = prepareCase("custom-workflow", () => {
    seedWorker("active-worker", "active");
  });
  assertCoordinationBlocked(prepared, { active_workers: 1 });
});

test("an active worker blocks even when its recorded project root does not match the authority", () => {
  const prepared = prepareCase("custom-workflow", () => {
    db().prepare(`INSERT INTO workers (
        worker_id, host, pid, started_at, version, last_heartbeat_at, status,
        project_root_realpath
      ) VALUES (
        'relocated-worker', 'test-host', 999, '1970-01-01T00:00:00.000Z', 'test',
        '1970-01-01T00:00:00.000Z', 'active', '/pre-cutover/project-root'
      )`).run();
  });
  assertCoordinationBlocked(prepared, { active_workers: 1 });
});

test("a held milestone lease blocks by status even when its expiry is historical", () => {
  const prepared = prepareCase("custom-workflow", () => {
    seedHierarchy();
    seedWorker("lease-worker", "crashed");
    seedLease("lease-worker", "held");
  });
  assertCoordinationBlocked(prepared, { active_workers: 0, held_leases: 1 });
});

for (const [index, dispatchState] of ["claimed", "running"].entries()) {
  test(`a ${dispatchState} dispatch blocks by authoritative status`, () => {
    const prepared = prepareCase("custom-workflow", () => {
      seedHierarchy();
      seedWorker("dispatch-worker", "crashed");
      seedLease("dispatch-worker", "released");
      seedDispatch("dispatch-worker", dispatchState as "claimed" | "running", index + 1);
    });
    assertCoordinationBlocked(prepared, {
      active_workers: 0,
      held_leases: 0,
      active_dispatches: 1,
    });
  });
}

for (const attemptState of ["claimed", "running"] as const) {
  test(`a ${attemptState} workflow Attempt blocks by authoritative status`, () => {
    const prepared = prepareCase("custom-workflow", () => seedAttempt(attemptState));
    assertCoordinationBlocked(prepared, {
      active_workers: 0,
      held_leases: 0,
      active_dispatches: 0,
      active_attempts: 1,
    });
  });
}

test("terminal coordination statuses do not falsely block Application", () => {
  const applyLegacyImport = getApplyLegacyImport();
  const prepared = prepareCase("custom-workflow", () => {
    seedAttempt("settled");
    seedWorker("terminal-worker", "stopping");
    seedWorker("crashed-worker", "crashed");
    seedDispatch("terminal-worker", "completed", 1);
    seedDispatch("terminal-worker", "failed", 2);
    seedDispatch("terminal-worker", "canceled", 3);
  });

  const result = applyLegacyImport(prepared.input);

  assertCommittedResult(prepared, result);
  assertStoredAggregate(prepared, result);
  assert.deepEqual(row(`SELECT
      (SELECT COUNT(*) FROM workers WHERE status = 'active') AS active_workers,
      (SELECT COUNT(*) FROM milestone_leases WHERE status = 'held') AS held_leases,
      (SELECT COUNT(*) FROM unit_dispatches WHERE status IN ('claimed', 'running')) AS active_dispatches,
      (SELECT COUNT(*) FROM workflow_execution_attempts WHERE attempt_state IN ('claimed', 'running')) AS active_attempts`), {
    active_workers: 0,
    held_leases: 0,
    active_dispatches: 0,
    active_attempts: 0,
  });
});
