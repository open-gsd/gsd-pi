// Project/App: gsd-pi
// File Purpose: Filesystem-state (markdown) authority cutover end-to-end:
// EXCLUSIVE-claim commit, idempotent replay, loud epoch/key refusal,
// verified-backup rollback, and writer-contention fencing.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import {
  executeImportDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import {
  _getAdapter,
  checkpointDatabase,
  closeDatabase,
  openDatabase,
  openIsolatedDatabase,
  snapshotDatabaseFile,
  withDatabaseMaintenanceClaim,
  SCHEMA_VERSION,
} from "../gsd-db.ts";
import { databaseMaintenanceIntentPath } from "../database-maintenance-fence.ts";
import { processStartIdentity } from "../process-start-identity.ts";
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
  type ProjectAuthorityCutoverReceipt,
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
  const directory = mkdtempSync(join(tmpdir(), "gsd-authority-cutover-fs-"));
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

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function pollProcessIdentity(pid: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const identity = processStartIdentity(pid);
    if (identity !== null) return identity;
    if (Date.now() >= deadline) {
      throw new Error(`cannot prove the process-start identity of pid ${pid}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

// (a) End-to-end: a pre-cutover project flips filesystem-state authority to
// the DB via the op inside the startup EXCLUSIVE claim — verified backup,
// exact receipt lineage, durable receipt row, and no legacy-file deletion.
test("filesystem-state cutover commits inside the startup EXCLUSIVE claim with a verified backup", async (t) => {
  const databasePath = openFixture(t);
  const legacyFile = join(dirname(databasePath), "M001-CONTEXT.md");
  writeFileSync(legacyFile, "# M001: Legacy Markdown\n\nUser-owned legacy state.\n", "utf8");
  const evidence = seedApplication();
  assert.equal(evidence.databaseSchemaVersion, SCHEMA_VERSION);
  assert.equal(evidence.backupQuickCheck, "ok");
  assert.equal(evidence.projectRevision, 1);
  assert.equal(evidence.authorityEpoch, 0);

  // The rollback artifact: a standalone verified snapshot taken before the flip.
  const backupPath = `${databasePath}.backup-v${SCHEMA_VERSION}`;
  snapshotDatabaseFile(databasePath, backupPath);
  const backup = openIsolatedDatabase(backupPath);
  assert.ok(backup, "the verified backup must open read-only");
  try {
    assert.equal(String(backup.prepare("PRAGMA quick_check").get()?.["quick_check"]), "ok");
    assert.equal(
      Number(backup.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.["version"]),
      SCHEMA_VERSION,
    );
  } finally {
    backup.close();
  }

  let receipt: ProjectAuthorityCutoverReceipt | undefined;
  await withDatabaseMaintenanceClaim(async () => {
    receipt = cutoverProjectAuthority(input(evidence));
  });
  assert.ok(receipt);
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.priorRevision, 1);
  assert.equal(receipt.resultingRevision, 2);
  assert.equal(receipt.priorAuthorityEpoch, 0);
  assert.equal(receipt.resultingAuthorityEpoch, 1);
  assert.equal(receipt.filesystemStateAuthority, "db");
  assert.equal(receipt.eventIds.length, 1);
  assert.equal(receipt.outboxIds.length, 1);
  assert.equal(receipt.projectionWorkIds.length, 1);

  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 2,
    authority_epoch: 1,
  });
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").count, 1);
  const cutoverEvent = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'authority.cutover'
  `);
  const payload = JSON.parse(String(cutoverEvent.payload_json)) as Record<string, unknown>;
  assert.equal(payload["filesystemStateAuthority"], "db");
  assert.equal(
    Number(row("SELECT MAX(version) AS version FROM schema_version").version),
    SCHEMA_VERSION,
  );
  assert.equal(existsSync(legacyFile), true, "the flip never deletes legacy user files");
  assert.equal(
    existsSync(databaseMaintenanceIntentPath(databasePath)),
    false,
    "the EXCLUSIVE maintenance claim is released after the flip",
  );
});

// (b) Idempotent re-entry: the same idempotency key replays the committed
// receipt and mutates nothing — proven by the checkpointed database file hash.
test("idempotent cutover re-entry replays the receipt and leaves the database byte-identical", (t) => {
  const databasePath = openFixture(t);
  const evidence = seedApplication();
  const request = input(evidence);
  const committed = cutoverProjectAuthority(request);
  assert.equal(committed.status, "committed");
  assert.equal(committed.filesystemStateAuthority, "db");
  const afterCommit = durableSnapshot();
  checkpointDatabase();
  const hashBeforeReplay = sha256File(databasePath);

  const replayed = cutoverProjectAuthority(structuredClone(request));

  assert.deepEqual(replayed, { ...committed, status: "replayed" });
  checkpointDatabase();
  assert.equal(
    sha256File(databasePath),
    hashBeforeReplay,
    "idempotent replay must not write to the database file",
  );
  assert.deepEqual(durableSnapshot(), afterCommit);
});

// (c) Loud refusal: a wrong expectedAuthorityEpoch and a conflicting
// idempotency key both fail closed with no durable residue.
test("wrong-epoch and conflicting-key cutover invocations fail loudly without mutation", (t) => {
  openFixture(t);
  const evidence = seedApplication();
  const before = durableSnapshot();
  expectCode(
    () => cutoverProjectAuthority(
      input(evidence, { expectedAuthorityEpoch: evidence.authorityEpoch + 1 }),
    ),
    "PROJECT_AUTHORITY_CUTOVER_AUTHORITY_STALE",
  );
  assert.deepEqual(durableSnapshot(), before);

  const committed = cutoverProjectAuthority(input(evidence));
  assert.equal(committed.status, "committed");
  const afterCommit = durableSnapshot();
  expectCode(
    () => cutoverProjectAuthority(input(evidence, { evidenceHash: OTHER_HASH })),
    "PROJECT_AUTHORITY_CUTOVER_REPLAY_CONFLICT",
  );
  assert.deepEqual(durableSnapshot(), afterCommit);
});

// (d) Rollback: restoring the verified same-directory backup returns the
// project to the pre-cutover schema and authority head.
test("restoring the verified backup rolls the project back to the pre-cutover state", (t) => {
  const databasePath = openFixture(t);
  const evidence = seedApplication();
  const backupPath = `${databasePath}.backup-v${SCHEMA_VERSION}`;
  snapshotDatabaseFile(databasePath, backupPath);

  const receipt = cutoverProjectAuthority(input(evidence));
  assert.equal(receipt.status, "committed");
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 2,
    authority_epoch: 1,
  });
  assert.equal(row("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").count, 1);

  closeDatabase();
  copyFileSync(backupPath, databasePath);
  // Defensive: the last close usually checkpoints and removes the WAL
  // sidecars; any stragglers must not shadow the restored file.
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  assert.equal(openDatabase(databasePath), true);

  assert.equal(
    Number(row("SELECT MAX(version) AS version FROM schema_version").version),
    SCHEMA_VERSION,
    "the restored backup carries the pre-cutover schema version",
  );
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: evidence.projectRevision,
    authority_epoch: evidence.authorityEpoch,
  });
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").count,
    0,
    "the cutover receipt is gone after rollback",
  );
});

// (e) Writer contention: a live foreign database-maintenance owner fences the
// cutover with PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION before any
// mutation; once the foreign owner dies, the retry adopts the stale claim and
// commits inside a fresh EXCLUSIVE claim.
test("a live foreign maintenance owner fences the cutover; a dead owner lets the retry commit", async (t) => {
  const databasePath = openFixture(t);
  const evidence = seedApplication();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  child.on("error", () => {});
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const ownerPid = child.pid;
  assert.ok(ownerPid !== undefined && ownerPid > 0, "contention child must have a pid");
  const ownerIdentity = await pollProcessIdentity(ownerPid);

  const intentPath = databaseMaintenanceIntentPath(databasePath);
  writeFileSync(intentPath, JSON.stringify({
    schemaVersion: 1,
    ownerPid,
    ownerProcessStartIdentity: ownerIdentity,
    ownerNonce: randomUUID(),
  }), "utf8");

  expectCode(
    () => cutoverProjectAuthority(input(evidence)),
    "PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").count,
    0,
    "writer contention fails before any mutation",
  );
  assert.deepEqual(row("SELECT revision, authority_epoch FROM project_authority"), {
    revision: 1,
    authority_epoch: 0,
  });

  child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");

  let retried: ProjectAuthorityCutoverReceipt | undefined;
  await withDatabaseMaintenanceClaim(async () => {
    retried = cutoverProjectAuthority(input(evidence));
  });
  assert.ok(retried);
  assert.equal(retried.status, "committed");
  assert.equal(retried.filesystemStateAuthority, "db");
  assert.equal(
    existsSync(intentPath),
    false,
    "the stale foreign intent is adopted and released by the retry claim",
  );
});
