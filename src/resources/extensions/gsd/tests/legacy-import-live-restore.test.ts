// Project/App: gsd-pi
// File Purpose: Crash-safe real-file legacy Import Application restore contract.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
} from "../legacy-import-application.ts";
import {
  _restoreLegacyImportLiveForTest,
  replayLegacyImportLiveRestore,
  restoreLegacyImportLive,
  type LegacyImportLiveRestoreInput,
} from "../legacy-import-live-restore.ts";
import {
  canonicalLegacyImportJson,
  createLegacyImportPreview,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import {
  assessLegacyImportRestore,
  LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
} from "../legacy-import-restore-assessment.ts";
import {
  _executeImportRestoreDomainOperation,
  executeDomainOperation,
} from "../db/domain-operation.ts";
import { getDatabaseReplacementPaths, openIsolatedDatabase } from "../db/engine.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();
let sequence = 0;

function database(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function directReceiptPayload(prepared: ReturnType<typeof preparedInput>): Record<string, unknown> {
  const applicationOperationId = "erased-application-operation";
  const applicationIdentityHash = prepared.input.applicationIdentityHash;
  const applicationResultingProjectRevision = prepared.input.assessment.facts.currentProjectRevision + 1;
  const applicationResultingAuthorityEpoch = prepared.input.assessment.facts.currentAuthorityEpoch;
  const lineage = {
    schemaVersion: 1,
    applicationOperationId,
    applicationIdentityHash,
    applicationResultingProjectRevision,
    applicationResultingAuthorityEpoch,
  };
  return {
    applicationOperationId,
    applicationIdentityHash,
    applicationResultingProjectRevision,
    applicationResultingAuthorityEpoch,
    erasedLineageHash: hashLegacyImportValue(lineage),
    erasedLineageJson: canonicalLegacyImportJson(lineage),
    previewId: prepared.input.backup.preview_id,
    previewHash: prepared.input.backup.preview_hash,
    backupId: prepared.input.backup.backup_id,
    backupSha256: prepared.input.backup.backup_sha256,
    backupByteSize: prepared.input.backup.backup_byte_size,
    backupSchemaVersion: prepared.input.backup.backup_database_schema_version,
    backupProjectRevision: prepared.input.assessment.facts.currentProjectRevision,
    backupAuthorityEpoch: prepared.input.assessment.facts.currentAuthorityEpoch,
    differenceHash: prepared.input.assessment.facts.difference!.differenceHash,
    consentHash: hashLegacyImportValue(prepared.input.consent),
    verificationHash: hashLegacyImportValue("direct seam verification"),
  };
}

function preparedInput(): {
  input: LegacyImportLiveRestoreInput;
  databasePath: string;
  backupRelevantRowsHash: string;
} {
  sequence += 1;
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-live-restore-")));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backups = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backups);
  assert.equal(openDatabase(databasePath), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: backups,
    label: "before-live-restore",
  });
  const applicationInput: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/live-restore-application-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "live-restore-test",
    },
    previewInput,
    preview,
    backup,
  };
  const applicationIdentityHash = createLegacyImportApplicationIdentity(
    applicationInput,
  ).applicationIdentityHash;
  applyLegacyImport(applicationInput);
  const consentRequired = assessLegacyImportRestore({ applicationIdentityHash, backup });
  assert.equal(consentRequired.decision, "restore-consent-required");
  const consent = {
    consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
    decision: "proceed" as const,
    destructiveDatabaseRestore: true as const,
    evidenceHash: consentRequired.evidenceHash,
  };
  const assessment = assessLegacyImportRestore({ applicationIdentityHash, backup, consent });
  assert.equal(assessment.decision, "restore-eligible");
  return {
    databasePath,
    backupRelevantRowsHash: base.relevant_rows_hash,
    input: {
      invocation: {
        idempotencyKey: `legacy-import/live-restore-${sequence}`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "live-restore-test",
      },
      applicationIdentityHash,
      backup,
      assessment,
      consent,
    },
  };
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("live restore rejects accessor-backed input without reading it", () => {
  let accessed = false;
  const input = {
    get invocation(): never {
      accessed = true;
      throw new Error("must not read");
    },
  };
  assert.throws(
    () => restoreLegacyImportLive(input),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID",
  );
  assert.equal(accessed, false);
});

test("generic Domain Operations cannot bypass the typed import restore boundary", () => {
  const prepared = preparedInput();
  assert.throws(
    () => executeDomainOperation({
      operationType: "import.restore",
      idempotencyKey: "live-restore/generic-bypass",
      expectedRevision: prepared.input.assessment.facts.currentProjectRevision,
      expectedAuthorityEpoch: prepared.input.assessment.facts.currentAuthorityEpoch,
      actorType: "agent",
      sourceTransport: "internal",
      payload: {},
    }, () => ({
      events: [{
        eventType: "legacy-import.restored",
        entityType: "legacy-import",
        entityId: "forged",
        payload: {},
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: "legacy-import/restore", projectionKind: "markdown", rendererVersion: "v1" }],
    })),
    /typed import restore operation/,
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("typed import restore rejects accessors unread and rolls back without its exact receipt", () => {
  const prepared = preparedInput();
  const forgedCapability = Object.freeze({
    kind: "gsd-database-replacement-receipt-capability",
  }) as never;
  const payload = directReceiptPayload(prepared);
  let accessed = false;
  Object.defineProperty(payload, "applicationOperationId", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error("must not read");
    },
  });
  assert.throws(
    () => _executeImportRestoreDomainOperation(forgedCapability, {
      operationType: "import.restore",
      idempotencyKey: "live-restore/accessor-payload",
      expectedRevision: prepared.input.assessment.facts.currentProjectRevision,
      expectedAuthorityEpoch: prepared.input.assessment.facts.currentAuthorityEpoch,
      actorType: "agent",
      sourceTransport: "internal",
      payload: payload as never,
    }, () => ({ events: [], projections: [] })),
    /exact receipt contract/,
  );
  assert.equal(accessed, false);

  const stablePayload = directReceiptPayload(prepared);
  const beforeOperations = database().prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()?.["count"];
  assert.throws(
    () => _executeImportRestoreDomainOperation(forgedCapability, {
      operationType: "import.restore",
      idempotencyKey: "live-restore/missing-receipt",
      expectedRevision: prepared.input.assessment.facts.currentProjectRevision,
      expectedAuthorityEpoch: prepared.input.assessment.facts.currentAuthorityEpoch,
      actorType: "agent",
      sourceTransport: "internal",
      payload: stablePayload as never,
    }, () => ({
      events: [{
        eventType: "legacy-import.restored",
        entityType: "legacy-import",
        entityId: prepared.input.backup.preview_id,
        payload: stablePayload as never,
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: "legacy-import/restore", projectionKind: "markdown", rendererVersion: "v1" }],
    })),
    /Invalid or consumed database replacement receipt capability/,
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()?.["count"], beforeOperations);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("eligible live restore reinstalls the exact backup base and records erased lineage", () => {
  const prepared = preparedInput();
  const backupHash = sha256(prepared.input.backup.backup_ref);
  const result = restoreLegacyImportLive(prepared.input);
  assert.equal(result.status, "committed");
  assert.equal(result.resultingProjectRevision, prepared.input.backup.base_project_revision + 1);
  assert.equal(result.resultingAuthorityEpoch, prepared.input.backup.base_authority_epoch);
  assert.equal(result.backupId, prepared.input.backup.backup_id);
  assert.equal(result.applicationIdentityHash, prepared.input.applicationIdentityHash);

  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  const authority = database().prepare(`
    SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1
  `).get();
  assert.equal(authority?.["revision"], prepared.input.backup.base_project_revision + 1);
  assert.equal(authority?.["authority_epoch"], prepared.input.backup.base_authority_epoch);
  assert.equal(captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash, prepared.backupRelevantRowsHash);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 0);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'import.restore'").get()?.["count"], 1);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'legacy-import.restored'").get()?.["count"], 1);
  assert.equal(sha256(prepared.input.backup.backup_ref), backupHash);
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false);
  assert.equal(
    assessLegacyImportRestore({
      applicationIdentityHash: prepared.input.applicationIdentityHash,
      backup: prepared.input.backup,
    }).decision,
    "already-restored",
  );
  database().exec("DROP TRIGGER trg_workflow_domain_events_immutable_update");
  database().prepare(`
    UPDATE workflow_domain_events SET payload_json = '{}'
    WHERE event_type = 'legacy-import.restored'
  `).run();
  const damaged = assessLegacyImportRestore({
    applicationIdentityHash: prepared.input.applicationIdentityHash,
    backup: prepared.input.backup,
  });
  assert.equal(damaged.decision, "refused");
  assert.equal(damaged.reasonCode, "APPLICATION_EVIDENCE_INVALID");
});

test("fresh recheck refuses accepted work without touching the live file or backup", () => {
  const prepared = preparedInput();
  const backupHash = sha256(prepared.input.backup.backup_ref);
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: "live-restore/later-work",
    expectedRevision: prepared.input.assessment.facts.currentProjectRevision,
    expectedAuthorityEpoch: prepared.input.assessment.facts.currentAuthorityEpoch,
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
    projections: [{
      projectionKey: "milestone/m001",
      projectionKind: "state",
      rendererVersion: "v1",
    }],
  }));
  const liveHash = sha256(prepared.databasePath);

  assert.throws(
    () => restoreLegacyImportLive(prepared.input),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE",
  );
  assert.equal(sha256(prepared.databasePath), liveHash);
  assert.equal(sha256(prepared.input.backup.backup_ref), backupHash);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false);
});

test("exclusive intent ownership lets one restore finish while a contender retries", () => {
  const prepared = preparedInput();
  let contender: unknown;
  const result = _restoreLegacyImportLiveForTest(prepared.input, {
    boundary(point) {
      if (point !== "after-intent" || contender !== undefined) return;
      try {
        restoreLegacyImportLive(structuredClone(prepared.input));
      } catch (error) {
        contender = error;
      }
    },
  });
  assert.equal(result.status, "committed");
  assert.equal((contender as { code?: unknown }).code, "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT");
  assert.equal((contender as { retryable?: unknown }).retryable, true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
});

test("an abandoned claimed intent is cleaned and retried from the unchanged original inode", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point !== "after-intent") return;
        const intent = JSON.parse(readFileSync(paths.activeIntentPath, "utf8")) as Record<string, unknown>;
        intent["ownerPid"] = 99_999_999;
        writeFileSync(paths.activeIntentPath, JSON.stringify(intent));
        throw new Error("injected owner death after claim");
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_STAGE_FAILED",
  );
  assert.equal(existsSync(paths.activeIntentPath), true);
  assert.equal(restoreLegacyImportLive(structuredClone(prepared.input)).status, "committed");
  assert.equal(existsSync(paths.recoveryDirectory), false);
});

test("a reused live PID cannot preserve an abandoned restore intent", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  assert.ok(unrelated.pid);
  try {
    assert.throws(
      () => _restoreLegacyImportLiveForTest(prepared.input, {
        boundary(point) {
          if (point !== "after-intent") return;
          const intent = JSON.parse(readFileSync(paths.activeIntentPath, "utf8")) as Record<string, unknown>;
          intent["ownerPid"] = unrelated.pid;
          writeFileSync(paths.activeIntentPath, JSON.stringify(intent));
          throw new Error("injected owner exit followed by PID reuse");
        },
      }),
      (error: unknown) => (error as { code?: unknown }).code
        === "LEGACY_IMPORT_LIVE_RESTORE_STAGE_FAILED",
    );

    assert.equal(existsSync(paths.activeIntentPath), true);
    assert.equal(restoreLegacyImportLive(structuredClone(prepared.input)).status, "committed");
    assert.equal(existsSync(paths.recoveryDirectory), false);
  } finally {
    unrelated.kill("SIGKILL");
  }
});

test("intent identity tampering is retained and blocks ownership cleanup", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point !== "after-intent") return;
        const intent = JSON.parse(readFileSync(paths.activeIntentPath, "utf8")) as Record<string, unknown>;
        intent["backupId"] = `sha256:${"0".repeat(64)}`;
        writeFileSync(paths.activeIntentPath, JSON.stringify(intent));
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
  );
  assert.equal(existsSync(paths.activeIntentPath), true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("unsafe active intent links fail closed before reading external content", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  mkdirSync(paths.recoveryDirectory, { recursive: true });
  const external = join(paths.recoveryDirectory, "external.json");
  writeFileSync(external, "{}");
  symlinkSync(external, paths.activeIntentPath);
  assert.throws(
    () => restoreLegacyImportLive(prepared.input),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 1);
});

test("published-byte tampering is measured before reopen and cannot record a receipt", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      publish(candidate, databasePath) {
        renameSync(candidate, databasePath);
        const bytes = readFileSync(databasePath);
        const changed = (bytes.readUInt32BE(24) + 1) >>> 0;
        bytes.writeUInt32BE(changed, 24);
        bytes.writeUInt32BE(changed, 92);
        writeFileSync(databasePath, bytes);
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED"
      && String((error as { cause?: unknown }).cause).includes("expected SHA-256"),
  );
  assert.equal(existsSync(paths.activeIntentPath), true);
  assert.equal(openDatabase(prepared.databasePath), true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
  assert.equal(restoreLegacyImportLive(structuredClone(prepared.input)).status, "committed");
});

test("unsupported directory durability fails before replacing the database", () => {
  const prepared = preparedInput();
  const liveHash = sha256(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      syncDirectory() {
        throw Object.assign(new Error("directory synchronization unsupported"), { code: "ENOTSUP" });
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_STAGE_FAILED",
  );
  assert.equal(sha256(prepared.databasePath), liveHash);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 1);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("exact retry replays one durable restore without adding lineage", () => {
  const prepared = preparedInput();
  const committed = restoreLegacyImportLive(prepared.input);
  const countsBefore = database().prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_operations WHERE operation_type = 'import.restore') AS operations,
      (SELECT COUNT(*) FROM workflow_import_restores) AS receipts,
      (SELECT COUNT(*) FROM workflow_domain_events WHERE event_type = 'legacy-import.restored') AS events
  `).get();
  const replayed = restoreLegacyImportLive(structuredClone(prepared.input));
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, committed.operationId);
  assert.deepEqual(database().prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_operations WHERE operation_type = 'import.restore') AS operations,
      (SELECT COUNT(*) FROM workflow_import_restores) AS receipts,
      (SELECT COUNT(*) FROM workflow_domain_events WHERE event_type = 'legacy-import.restored') AS events
  `).get(), countsBefore);
});

test("durable restore replay enforces the strict exact-keys contract", () => {
  const prepared = preparedInput();
  const committed = restoreLegacyImportLive(prepared.input);
  const replayInput = {
    applicationIdentityHash: prepared.input.applicationIdentityHash,
    backup: prepared.input.backup,
    consent: prepared.input.consent,
  };
  const replayed = replayLegacyImportLiveRestore(replayInput);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, committed.operationId);

  // Extra top-level keys and extra Consent keys were previously tolerated at
  // this boundary while the live boundary rejected them; both must fail the
  // exact contract.
  for (const forged of [
    { ...replayInput, tolerated: "extra-top-level-key" },
    { ...replayInput, consent: { ...replayInput.consent, tolerated: "extra-consent-key" } },
  ]) {
    assert.throws(
      () => replayLegacyImportLiveRestore(forged as never),
      (error: unknown) => (error as { code?: unknown }).code
        === "LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID",
    );
  }
});

test("exact restore replay returns its durable receipt after later accepted work", () => {
  const prepared = preparedInput();
  const committed = restoreLegacyImportLive(prepared.input);
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `live-restore/later-work-${sequence}`,
    expectedRevision: committed.resultingProjectRevision,
    expectedAuthorityEpoch: committed.resultingAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M-LATER" },
  }, () => {
    database().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-LATER', 'Accepted after restore', 'active', '2026-07-18T00:00:00.000Z')`).run();
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-LATER",
        payload: { title: "Accepted after restore" },
        destinations: ["projection"],
      }],
      projections: [{ projectionKey: "milestone/m-later", projectionKind: "markdown", rendererVersion: "v1" }],
    };
  });

  const replayed = restoreLegacyImportLive(structuredClone(prepared.input));
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, committed.operationId);
  assert.deepEqual(replayed.verification, committed.verification);
  assert.equal(database().prepare("SELECT title FROM milestones WHERE id = 'M-LATER'").get()?.["title"], "Accepted after restore");
});

test("replacement closes tracked isolated connections before publishing a new inode", () => {
  const prepared = preparedInput();
  const observer = openIsolatedDatabase(prepared.databasePath);
  assert.ok(observer);
  assert.equal(observer.prepare("SELECT 1 AS value").get()?.["value"], 1);
  const result = restoreLegacyImportLive(prepared.input);
  assert.equal(result.status, "committed");
  assert.throws(() => observer.prepare("SELECT 1 AS value").get());
  assert.doesNotThrow(() => observer.close());
});

test("pre-publication failure reopens the exact Application head and cleans private state", () => {
  const prepared = preparedInput();
  const before = database().prepare(`
    SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1
  `).get();
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point === "after-detach") throw new Error("injected before publication");
      },
    }),
    /live restore failed before publication/,
  );
  assert.deepEqual(database().prepare(`
    SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1
  `).get(), before);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 1);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false);
});

test("post-publication interruption converges only the same content-addressed request", () => {
  const prepared = preparedInput();
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point === "after-publish") throw new Error("injected after publication");
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED",
  );
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.equal(existsSync(paths.activeIntentPath), true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 0);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
  assert.throws(
    () => executeDomainOperation({
      operationType: "milestone.describe",
      idempotencyKey: "live-restore/fenced-writer",
      expectedRevision: prepared.input.backup.base_project_revision,
      expectedAuthorityEpoch: prepared.input.backup.base_authority_epoch,
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
      projections: [{ projectionKey: "milestone/m001", projectionKind: "state", rendererVersion: "v1" }],
    })),
    /writes are fenced/,
  );

  const result = restoreLegacyImportLive(structuredClone(prepared.input));
  assert.equal(result.status, "committed");
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
  assert.equal(existsSync(paths.recoveryDirectory), false);
});

test("rename-before-intent interruption converges from the durable staged file identity", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point === "after-database-publish") throw new Error("injected between rename and intent update");
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED",
  );
  const staged = JSON.parse(readFileSync(paths.activeIntentPath, "utf8")) as Record<string, unknown>;
  assert.equal(staged["stage"], "staged");
  assert.equal(typeof staged["candidateDatabaseInode"], "string");

  const result = restoreLegacyImportLive(structuredClone(prepared.input));
  assert.equal(result.status, "committed");
  assert.equal(existsSync(paths.recoveryDirectory), false);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
});

test("receipt capability rejects an exact-content intent inode swap before transaction", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point !== "after-reopen") return;
        const content = readFileSync(paths.activeIntentPath);
        unlinkSync(paths.activeIntentPath);
        writeFileSync(paths.activeIntentPath, content, { mode: 0o600 });
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED"
      && String((error as { cause?: unknown }).cause).includes("replacement proof"),
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
  assert.equal(restoreLegacyImportLive(structuredClone(prepared.input)).status, "committed");
});

test("receipt capability rejects in-place intent content drift before transaction", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point !== "after-reopen") return;
        const intent = JSON.parse(readFileSync(paths.activeIntentPath, "utf8")) as Record<string, unknown>;
        intent["ownerNonce"] = "00000000-0000-4000-8000-000000000000";
        writeFileSync(paths.activeIntentPath, JSON.stringify(intent));
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED"
      && String((error as { cause?: unknown }).cause).includes("replacement proof"),
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("intent drift after receipt staging rolls the transaction back before commit", () => {
  const prepared = preparedInput();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point !== "before-receipt-commit") return;
        const intent = JSON.parse(readFileSync(paths.activeIntentPath, "utf8")) as Record<string, unknown>;
        intent["ownerNonce"] = "00000000-0000-4000-8000-000000000000";
        writeFileSync(paths.activeIntentPath, JSON.stringify(intent));
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED"
      && String((error as { cause?: unknown }).cause).includes("replacement proof"),
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'import.restore'").get()?.["count"], 0);
});

test("dangling SQLite sidecar links are unlinked without touching their targets", () => {
  const prepared = preparedInput();
  const sidecar = `${prepared.databasePath}-wal`;
  const externalTarget = `${prepared.databasePath}-external-target`;
  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point === "after-detach") symlinkSync(externalTarget, sidecar);
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED",
  );
  assert.equal(existsSync(sidecar) && lstatSync(sidecar).isSymbolicLink(), false);
  assert.equal(existsSync(externalTarget), false);
  assert.equal(restoreLegacyImportLive(structuredClone(prepared.input)).status, "committed");
});
