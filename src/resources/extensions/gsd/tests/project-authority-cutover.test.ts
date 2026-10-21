// Project/App: gsd-pi
// File Purpose: Public contract, replay, fault, and process proof for typed authority cutover.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, type TestContext } from "node:test";

import {
  _executeAuthorityCutoverDomainOperation,
  _setDomainOperationFaultForTest,
  executeDomainOperation,
  executeImportDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import { insertAuthorityCutoverReceipt } from "../db/writers/authority-recovery.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
  SCHEMA_VERSION,
} from "../gsd-db.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import {
  LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION,
} from "../legacy-import-application.ts";
import { compileLegacyImportApplicationPlan } from "../legacy-import-application-plan.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import {
  cutoverProjectAuthority,
  inspectProjectAuthorityCutoverEvidence,
  PROJECT_AUTHORITY_CONTRACT_VERSION,
  PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
  type ProjectAuthorityCutoverEvidence,
  type ProjectAuthorityCutoverInput,
} from "../project-authority-cutover-domain-operation.ts";

const tempDirs = new Set<string>();
const APPLICATION_IDENTITY_HASH = `sha256:${"1".repeat(64)}`;
const BACKUP_ID = `sha256:${"2".repeat(64)}`;
const OTHER_HASH = `sha256:${"3".repeat(64)}`;
const PREVIEW_INPUT_HASH = `sha256:${"4".repeat(64)}`;
const BACKUP_ARTIFACT_HASH = `sha256:${"5".repeat(64)}`;

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const database = _getAdapter();
  assert.ok(database);
  return database;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function openFixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "gsd-authority-cutover-"));
  tempDirs.add(directory);
  const databasePath = join(directory, "gsd.db");
  assert.equal(openDatabase(databasePath), true);
  db().prepare(`
    UPDATE project_authority SET project_root_realpath = :root
    WHERE singleton = 1
  `).run({ ":root": directory });
  t.after(closeDatabase);
  return databasePath;
}

function preview(): LegacyImportPreviewArtifact {
  const authority = row(`
    SELECT singleton, project_id, project_root_realpath, revision, authority_epoch,
           created_at, updated_at
    FROM project_authority WHERE singleton = 1
  `);
  const emptyHash = hashLegacyImportValue([]);
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: SCHEMA_VERSION,
      authority: authority as {
        singleton: 1;
        project_id: string;
        project_root_realpath: string;
        revision: number;
        authority_epoch: number;
        created_at: string;
        updated_at: string;
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

function insertApplication(
  context: Readonly<DomainOperationContext>,
  artifact: LegacyImportPreviewArtifact,
): void {
  const value = artifact.preview;
  const appliedAt = String(db().prepare(`
    SELECT created_at FROM workflow_operations WHERE operation_id = :operation_id
  `).get({ ":operation_id": context.operationId })?.["created_at"]);
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
      0, 0, 0, 0, 0, 0, :preview_json,
      'verified-backup.sqlite', :backup_sha256, 4096, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch, 'ok', :backup_verified_at,
      :applied_at, :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":import_kind": value.import_kind,
    ":importer_version": value.importer_version,
    ":preview_schema_version": value.preview_schema_version,
    ":preview_id": value.preview_id,
    ":preview_hash": artifact.preview_hash,
    ":base_project_revision": value.base_project_revision,
    ":base_authority_epoch": value.base_authority_epoch,
    ":base_database_schema_version": value.base_database_schema_version,
    ":source_set_hash": value.source_set_hash,
    ":change_set_hash": value.change_set_hash,
    ":preview_json": canonicalLegacyImportJson(value),
    ":backup_sha256": BACKUP_ID,
    ":backup_schema_version": value.base_database_schema_version,
    ":backup_project_revision": value.base_project_revision,
    ":backup_authority_epoch": value.base_authority_epoch,
    ":backup_verified_at": "2026-07-17T00:00:00.000Z",
    ":applied_at": appliedAt,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
}

function seedApplication(): ProjectAuthorityCutoverEvidence {
  const artifact = preview();
  const plan = compileLegacyImportApplicationPlan(artifact);
  executeImportDomainOperation({
    operationType: "import.apply",
    idempotencyKey: "cutover/application",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "internal",
    payload: artifact,
  }, (context) => {
    insertApplication(context, artifact);
    return {
      events: [{
        eventType: "legacy-import.applied",
        entityType: "legacy-import",
        entityId: artifact.preview.preview_id,
        payload: {
          replayIdentitySchemaVersion: LEGACY_IMPORT_APPLICATION_REPLAY_IDENTITY_SCHEMA_VERSION,
          applicationIdentityHash: APPLICATION_IDENTITY_HASH,
          previewInputHash: PREVIEW_INPUT_HASH,
          backupArtifactHash: BACKUP_ARTIFACT_HASH,
          backupId: BACKUP_ID,
          applicationRelevantRowsHash: captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash,
          planSchemaVersion: plan.planSchemaVersion,
          eventFacts: plan.eventFacts as unknown as DomainJsonValue,
          projectionKeys: [...plan.projectionKeys],
          instructionResults: [],
        },
        destinations: ["projection"],
      }],
      projections: plan.projectionKeys.map((projectionKey) => ({
        projectionKey,
        projectionKind: "markdown",
        rendererVersion: "v1",
      })),
    };
  });
  return inspectProjectAuthorityCutoverEvidence();
}

function input(
  evidence: ProjectAuthorityCutoverEvidence,
  overrides: Partial<ProjectAuthorityCutoverInput> = {},
): ProjectAuthorityCutoverInput {
  const evidenceHash = overrides.evidenceHash ?? evidence.evidenceHash;
  return {
    invocation: {
      idempotencyKey: "cutover/request-1",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "cutover-test",
      traceId: "cutover-trace",
    },
    expectedRevision: evidence.projectRevision,
    expectedAuthorityEpoch: evidence.authorityEpoch,
    authorityContractVersion: PROJECT_AUTHORITY_CONTRACT_VERSION,
    evidenceHash,
    consent: {
      consentSchemaVersion: PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      irreversibleAuthorityCutover: true,
      evidenceHash,
    },
    ...overrides,
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: row("SELECT revision, authority_epoch FROM project_authority"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    applications: rows("SELECT * FROM workflow_import_applications"),
    cutovers: rows("SELECT * FROM workflow_authority_cutovers"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision"),
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code);
    return true;
  });
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

test("the internal cutover seam rolls back without one exact payload-bound receipt", (t) => {
  openFixture(t);
  const before = durableSnapshot();
  const request = {
    operationType: "authority.cutover" as const,
    idempotencyKey: "cutover/internal-bypass",
    expectedRevision: 0,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "internal",
    payload: {
      authorityContractVersion: 1,
      evidenceHash: APPLICATION_IDENTITY_HASH,
      consentHash: BACKUP_ID,
    },
  };
  const mutation = {
    events: [{
      eventType: "authority.cutover",
      entityType: "project",
      entityId: "bypass",
      payload: {},
      destinations: ["projection"],
    }],
    projections: [{ projectionKey: "project/authority", projectionKind: "state", rendererVersion: "1" }],
  };

  assert.throws(
    () => _executeAuthorityCutoverDomainOperation(request, () => mutation),
    /requires one exact receipt/,
  );
  assert.deepEqual(durableSnapshot(), before);

  assert.throws(
    () => _executeAuthorityCutoverDomainOperation(request, (context) => {
      insertAuthorityCutoverReceipt(context, {
        authorityContractVersion: 1,
        evidenceHash: OTHER_HASH,
        consentHash: BACKUP_ID,
      });
      return mutation;
    }),
    /requires one exact receipt/,
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("typed authority cutover commits one exact advancing operation and immutable receipt lineage", (t) => {
  openFixture(t);
  const evidence = seedApplication();
  assert.equal(evidence.projectRevision, 1);
  assert.equal(evidence.authorityEpoch, 0);
  assert.equal(Object.isFrozen(evidence), true);

  const receipt = cutoverProjectAuthority(input(evidence));
  assert.deepEqual({
    status: receipt.status,
    authorityContractVersion: receipt.authorityContractVersion,
    evidenceHash: receipt.evidenceHash,
    priorRevision: receipt.priorRevision,
    resultingRevision: receipt.resultingRevision,
    priorAuthorityEpoch: receipt.priorAuthorityEpoch,
    resultingAuthorityEpoch: receipt.resultingAuthorityEpoch,
    eventCount: receipt.eventIds.length,
    outboxCount: receipt.outboxIds.length,
    projectionCount: receipt.projectionWorkIds.length,
  }, {
    status: "committed",
    authorityContractVersion: 1,
    evidenceHash: evidence.evidenceHash,
    priorRevision: 1,
    resultingRevision: 2,
    priorAuthorityEpoch: 0,
    resultingAuthorityEpoch: 1,
    eventCount: 1,
    outboxCount: 1,
    projectionCount: 1,
  });
  assert.match(receipt.consentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 2,
    authority_epoch: 1,
  });
  assert.deepEqual(row(`
    SELECT operation.operation_type, operation.expected_revision, operation.resulting_revision,
           operation.expected_authority_epoch, operation.resulting_authority_epoch,
           receipt.authority_contract_version, receipt.evidence_hash, receipt.consent_hash,
           operation.created_at = receipt.cutover_at AS exact_time
    FROM workflow_operations operation
    JOIN workflow_authority_cutovers receipt USING(operation_id)
  `), {
    operation_type: "authority.cutover",
    expected_revision: 1,
    resulting_revision: 2,
    expected_authority_epoch: 0,
    resulting_authority_epoch: 1,
    authority_contract_version: 1,
    evidence_hash: evidence.evidenceHash,
    consent_hash: receipt.consentHash,
    exact_time: 1,
  });
});

test("authority cutover rejects absent Consent, changed evidence, and unsupported contracts without residue", (t) => {
  openFixture(t);
  const evidence = seedApplication();
  const before = durableSnapshot();
  const valid = input(evidence);

  expectCode(
    () => cutoverProjectAuthority({ ...valid, consent: undefined }),
    "PROJECT_AUTHORITY_CUTOVER_CONSENT_REQUIRED",
  );
  expectCode(
    () => cutoverProjectAuthority(input(evidence, { evidenceHash: OTHER_HASH })),
    "PROJECT_AUTHORITY_CUTOVER_EVIDENCE_CHANGED",
  );
  expectCode(
    () => cutoverProjectAuthority({ ...valid, authorityContractVersion: 2 }),
    "PROJECT_AUTHORITY_CUTOVER_SCHEMA_UNSUPPORTED",
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("authority cutover rejects a future database schema and damaged replay lineage", (t) => {
  openFixture(t);
  let evidence = seedApplication();
  let request = input(evidence);
  db().prepare(`
    INSERT INTO schema_version (version, applied_at)
    VALUES (${SCHEMA_VERSION + 1}, '2026-07-17T00:00:02.000Z')
  `).run();
  expectCode(
    () => cutoverProjectAuthority(request),
    "PROJECT_AUTHORITY_CUTOVER_SCHEMA_UNSUPPORTED",
  );
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 1,
    authority_epoch: 0,
  });

  closeDatabase();
  openFixture(t);
  evidence = seedApplication();
  request = input(evidence);
  cutoverProjectAuthority(request);
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  const cutoverEvent = row(`
    SELECT event_id, payload_json FROM workflow_domain_events
    WHERE event_type = 'authority.cutover'
  `);
  const cutoverPayload = JSON.parse(String(cutoverEvent.payload_json)) as Record<string, unknown>;
  db().prepare(`
    UPDATE workflow_domain_events SET payload_json = :payload_json WHERE event_id = :event_id
  `).run({
    ":event_id": cutoverEvent.event_id,
    ":payload_json": JSON.stringify({
      ...cutoverPayload,
      applicationIdentityHash: OTHER_HASH,
    }),
  });
  expectCode(
    () => cutoverProjectAuthority(request),
    "PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED",
  );
});

test("malformed durable Application evidence is reported as not current", (t) => {
  openFixture(t);
  seedApplication();
  db().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  const applicationEvent = row(`
    SELECT event_id, payload_json FROM workflow_domain_events
    WHERE event_type = 'legacy-import.applied'
  `);
  const payload = JSON.parse(String(applicationEvent.payload_json)) as Record<string, unknown>;
  db().prepare(`
    UPDATE workflow_domain_events SET payload_json = :payload_json WHERE event_id = :event_id
  `).run({
    ":event_id": applicationEvent.event_id,
    ":payload_json": JSON.stringify({ ...payload, applicationIdentityHash: "damaged" }),
  });

  expectCode(
    () => inspectProjectAuthorityCutoverEvidence(),
    "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT",
  );
});

test("authority cutover rejects unrecorded row drift after Application", (t) => {
  openFixture(t);
  seedApplication();
  db().prepare(`
    INSERT INTO milestones (id, title, status) VALUES ('M001', 'unrecorded', 'active')
  `).run();

  expectCode(
    () => inspectProjectAuthorityCutoverEvidence(),
    "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT",
  );
});

test("authority cutover stale revision and epoch fail before mutation", (t) => {
  openFixture(t);
  const evidence = seedApplication();
  const before = durableSnapshot();
  expectCode(
    () => cutoverProjectAuthority(input(evidence, { expectedRevision: 0 })),
    "PROJECT_AUTHORITY_CUTOVER_AUTHORITY_STALE",
  );
  expectCode(
    () => cutoverProjectAuthority(input(evidence, { expectedAuthorityEpoch: 1 })),
    "PROJECT_AUTHORITY_CUTOVER_AUTHORITY_STALE",
  );
  assert.deepEqual(durableSnapshot(), before);
});

test("later canonical work and active coordination close the cutover attempt without advancing epoch", (t) => {
  openFixture(t);
  const evidence = seedApplication();
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: "cutover/later-work",
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
  const afterLaterWork = durableSnapshot();
  expectCode(
    () => cutoverProjectAuthority(input(evidence, { expectedRevision: 2 })),
    "PROJECT_AUTHORITY_CUTOVER_APPLICATION_NOT_CURRENT",
  );
  assert.deepEqual(durableSnapshot(), afterLaterWork);

  closeDatabase();
  openFixture(t);
  const activeEvidence = seedApplication();
  const projectRoot = activeEvidence.projectRootRealpath;
  db().prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at,
      status, project_root_realpath
    ) VALUES (
      'cutover-active-worker', 'test', 1, '2026-07-17T00:00:00.000Z', '1',
      '2026-07-17T00:00:00.000Z', 'active', :root
    )
  `).run({ ":root": projectRoot });
  const beforeCoordination = durableSnapshot();
  expectCode(
    () => cutoverProjectAuthority(input(activeEvidence)),
    "PROJECT_AUTHORITY_CUTOVER_COORDINATION_ACTIVE",
  );
  assert.deepEqual(durableSnapshot(), beforeCoordination);
});

test("exact retry and restart replay one cutover while changed identity conflicts", (t) => {
  const databasePath = openFixture(t);
  const evidence = seedApplication();
  const request = input(evidence);
  const committed = cutoverProjectAuthority(request);
  const afterCommit = durableSnapshot();
  assert.deepEqual(cutoverProjectAuthority(structuredClone(request)), {
    ...committed,
    status: "replayed",
  });
  closeDatabase();
  assert.equal(openDatabase(databasePath), true);
  assert.deepEqual(cutoverProjectAuthority(request), { ...committed, status: "replayed" });
  expectCode(
    () => cutoverProjectAuthority(input(evidence, {
      invocation: { ...request.invocation, idempotencyKey: request.invocation.idempotencyKey },
      evidenceHash: OTHER_HASH,
    })),
    "PROJECT_AUTHORITY_CUTOVER_REPLAY_CONFLICT",
  );
  assert.deepEqual(durableSnapshot(), afterCommit);
});

test("cutover faults roll back before CAS and replay after a lost committed response", (t) => {
  let databasePath = openFixture(t);
  let evidence = seedApplication();
  let request = input(evidence);
  const before = durableSnapshot();
  _setDomainOperationFaultForTest("before-cas");
  expectCode(
    () => cutoverProjectAuthority(request),
    "PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED",
  );
  assert.deepEqual(durableSnapshot(), before);

  closeDatabase();
  _setDomainOperationFaultForTest(null);
  databasePath = openFixture(t);
  evidence = seedApplication();
  request = input(evidence);
  _setDomainOperationFaultForTest("after-commit");
  expectCode(
    () => cutoverProjectAuthority(request),
    "PROJECT_AUTHORITY_CUTOVER_MUTATION_FAILED",
  );
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  assert.equal(openDatabase(databasePath), true);
  const replay = cutoverProjectAuthority(request);
  assert.equal(replay.status, "replayed");
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 2,
    authority_epoch: 1,
  });
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").count, 1);
});

interface ProcessOutcome {
  kind: "result" | "error";
  status?: string;
  operationId?: string;
  code?: string;
  message?: string;
}

function runCutoverProcess(
  databasePath: string,
  request: ProjectAuthorityCutoverInput,
  readyPath: string,
  releasePath: string,
): Promise<ProcessOutcome> {
  const dbHref = pathToFileURL(join(process.cwd(), "src/resources/extensions/gsd/gsd-db.ts")).href;
  const cutoverHref = pathToFileURL(join(
    process.cwd(),
    "src/resources/extensions/gsd/project-authority-cutover-domain-operation.ts",
  )).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { openDatabase, closeDatabase } from ${JSON.stringify(dbHref)};
    import { cutoverProjectAuthority } from ${JSON.stringify(cutoverHref)};
    const [databasePath, encodedRequest, readyPath, releasePath] = process.argv.slice(1);
    if (!openDatabase(databasePath)) throw new Error('database open failed');
    writeFileSync(readyPath, 'ready');
    const deadline = Date.now() + 30000;
    while (!existsSync(releasePath)) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for the race release');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    try {
      const result = cutoverProjectAuthority(JSON.parse(encodedRequest));
      console.log(JSON.stringify({ kind: 'result', status: result.status, operationId: result.operationId }));
    } catch (error) {
      console.log(JSON.stringify({ kind: 'error', code: error?.code ?? null, message: String(error?.message ?? error) }));
    } finally { closeDatabase(); }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "./src/resources/extensions/gsd/tests/resolve-ts.mjs",
      "--experimental-strip-types", "--input-type=module", "-e", script,
      databasePath, JSON.stringify(request), readyPath, releasePath,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `cutover worker exited ${code}`));
      try {
        resolve(JSON.parse(stdout.trim()) as ProcessOutcome);
      } catch {
        reject(new Error(`invalid cutover worker output: ${stdout}\n${stderr}`));
      }
    });
  });
}

async function waitForPath(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runCutoverRace(
  databasePath: string,
  requests: readonly [ProjectAuthorityCutoverInput, ProjectAuthorityCutoverInput],
): Promise<readonly [ProcessOutcome, ProcessOutcome]> {
  const barrier = (name: string) => join(dirname(databasePath), name);
  const readyPaths = [barrier("race-ready-1"), barrier("race-ready-2")] as const;
  const releasePath = barrier("race-release");
  const outcomes = [
    runCutoverProcess(databasePath, requests[0], readyPaths[0], releasePath),
    runCutoverProcess(databasePath, requests[1], readyPaths[1], releasePath),
  ];
  try {
    await Promise.all(readyPaths.map((path, index) => waitForPath(path, `cutover READY ${index + 1}`)));
  } catch (error) {
    writeFileSync(releasePath, "release", "utf8");
    await Promise.allSettled(outcomes);
    throw error;
  }
  writeFileSync(releasePath, "release", "utf8");
  return await Promise.all(outcomes) as [ProcessOutcome, ProcessOutcome];
}

test("same-request processes converge and different requests produce one stale loser", async (t) => {
  let databasePath = openFixture(t);
  let evidence = seedApplication();
  let request = input(evidence);
  closeDatabase();
  const same = await runCutoverRace(databasePath, [request, request]);
  assert.deepEqual(same.map((outcome) => outcome.kind).sort(), ["result", "result"]);
  assert.deepEqual(same.map((outcome) => outcome.status).sort(), ["committed", "replayed"]);
  assert.equal(new Set(same.map((outcome) => outcome.operationId)).size, 1);

  databasePath = openFixture(t);
  evidence = seedApplication();
  request = input(evidence);
  closeDatabase();
  const different = await runCutoverRace(databasePath, [
    request,
    {
      ...request,
      invocation: { ...request.invocation, idempotencyKey: "cutover/request-2" },
    },
  ]);
  assert.equal(different.filter((outcome) => outcome.kind === "result").length, 1);
  const loser = different.find((outcome) => outcome.kind === "error");
  assert.equal(loser?.code, "PROJECT_AUTHORITY_CUTOVER_AUTHORITY_STALE");
  assert.equal(openDatabase(databasePath), true);
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 2,
    authority_epoch: 1,
  });
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").count, 1);
});
