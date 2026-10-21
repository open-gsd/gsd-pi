// Project/App: gsd-pi
// File Purpose: Sole crash-convergent owner for an eligible live legacy-import database restore.

import { deepFreeze } from "./legacy-import-utils.js";

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { syncDirectoryEntry } from "@gsd/native/directory-sync";

import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  isValidLegacyImportVerifiedBackup,
  verifyLegacyImportBackupArtifact,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import {
  inspectLegacyImportApplicationEvidence,
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
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import {
  assessLegacyImportRestore,
  LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
  type LegacyImportRestoreAssessment,
  type LegacyImportRestoreAssessmentConsent,
} from "./legacy-import-restore-assessment.js";
import { openSqliteReadOnly } from "./sqlite-readonly.js";
import { processStartIdentity } from "./process-start-identity.js";
import {
  _executeImportRestoreDomainOperation,
  type DomainJsonValue,
} from "./db/domain-operation.js";
import {
  assertDatabaseMaintenanceAllowsReplacement,
  detachActiveDatabaseForReplacement,
  getDatabaseReplacementPaths,
  getDb,
  getDbPath,
  immediateTransaction,
  promoteDatabaseForReplacementRecovery,
  reopenDatabaseAfterReplacement,
  type DatabaseReplacementReopenEvidence,
  type DatabaseReplacementReceiptCapability,
  type DatabaseReplacementToken,
} from "./db/engine.js";
import { insertImportRestoreReceipt } from "./db/writers/authority-recovery.js";

export const LEGACY_IMPORT_LIVE_RESTORE_SCHEMA_VERSION = 1 as const;
const INTENT_SCHEMA_VERSION = 1 as const;
const INTENT_FILE = "active.json";
const CANDIDATE_FILE = "candidate.sqlite";
const RECOVERY_CLAIM_PREFIX = `${INTENT_FILE}.recovery-claim-`;

export type LegacyImportLiveRestoreStage =
  | "contract"
  | "recheck"
  | "stage"
  | "checkpoint"
  | "publish"
  | "reopen"
  | "verify"
  | "receipt"
  | "converge";

export type LegacyImportLiveRestoreErrorCode =
  | "LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID"
  | "LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE"
  | "LEGACY_IMPORT_LIVE_RESTORE_ASSESSMENT_CHANGED"
  | "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT"
  | "LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID"
  | "LEGACY_IMPORT_LIVE_RESTORE_STAGE_FAILED"
  | "LEGACY_IMPORT_LIVE_RESTORE_CHECKPOINT_FAILED"
  | "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED"
  | "LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED"
  | "LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED"
  | "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED";

export class LegacyImportLiveRestoreError extends Error {
  readonly code: LegacyImportLiveRestoreErrorCode;
  readonly stage: LegacyImportLiveRestoreStage;
  readonly retryable: boolean;
  readonly evidence: Readonly<Record<string, DomainJsonValue>>;

  constructor(
    code: LegacyImportLiveRestoreErrorCode,
    stage: LegacyImportLiveRestoreStage,
    message: string,
    retryable = false,
    evidence: Record<string, DomainJsonValue> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyImportLiveRestoreError";
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
    this.evidence = Object.freeze({ ...evidence });
  }
}

export interface LegacyImportLiveRestoreInput {
  readonly invocation: Readonly<ExecutionInvocation>;
  readonly applicationIdentityHash: string;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
  readonly assessment: Readonly<LegacyImportRestoreAssessment>;
  readonly consent: Readonly<LegacyImportRestoreAssessmentConsent>;
}

export interface LegacyImportLiveRestoreVerification {
  readonly verificationSchemaVersion: 1;
  readonly installedDatabaseSha256: string;
  readonly relevantRowsHash: string;
  readonly representativeRowsHash: string;
  readonly quickCheck: "ok";
  readonly integrityCheck: "ok";
  readonly foreignKeyViolations: 0;
}

export interface LegacyImportLiveRestoreResult {
  readonly status: "committed" | "replayed";
  readonly operationId: string;
  readonly projectId: string;
  readonly applicationOperationId: string;
  readonly applicationIdentityHash: string;
  readonly backupId: string;
  readonly backupSha256: string;
  readonly differenceHash: string;
  readonly consentHash: string;
  readonly verificationHash: string;
  readonly installedDatabaseSha256: string;
  readonly resultingProjectRevision: number;
  readonly resultingAuthorityEpoch: number;
  readonly eventIds: readonly string[];
  readonly outboxIds: readonly number[];
  readonly projectionWorkIds: readonly string[];
  readonly verification: Readonly<LegacyImportLiveRestoreVerification>;
}

export interface LegacyImportLiveRestoreReplayInput {
  readonly applicationIdentityHash: string;
  readonly backup: Readonly<LegacyImportVerifiedBackup>;
  readonly consent: Readonly<LegacyImportRestoreAssessmentConsent>;
}

type LiveRestoreBoundary =
  | "after-claim-write"
  | "after-claim-file-sync"
  | "after-claim-publish"
  | "after-claim-directory-sync"
  | "after-stage"
  | "after-intent"
  | "after-candidate-copy"
  | "after-candidate-sync"
  | "after-candidate-verify"
  | "after-recovery-copy"
  | "after-recovery-sync"
  | "after-recovery-intent"
  | "after-recovery-publish"
  | "before-final-assessment"
  | "after-final-assessment"
  | "after-checkpoint"
  | "after-journal-mode"
  | "after-active-close"
  | "after-detach"
  | "after-wal-removal"
  | "after-shm-removal"
  | "after-journal-removal"
  | "before-database-publish"
  | "after-database-publish"
  | "after-live-parent-sync"
  | "after-published-file-verify"
  | "after-publish"
  | "before-reopen-open"
  | "after-reopen-open"
  | "after-reopen-proof"
  | "after-reopen"
  | "after-quick-check"
  | "after-integrity-check"
  | "after-foreign-key-check"
  | "after-base-verification"
  | "before-receipt-commit"
  | "after-receipt"
  | "after-receipt-intent"
  | "after-receipt-checkpoint"
  | "after-database-sync"
  | "after-terminal-assessment"
  | "after-cleanup-claim-link"
  | "after-cleanup-claim-verify"
  | "after-cleanup-entries"
  | "after-cleanup-intent"
  | "after-cleanup-claim-unlink"
  | "after-cleanup-directory"
  | "after-cleanup";

interface LiveRestoreDependencies {
  boundary?(point: LiveRestoreBoundary, evidence?: Readonly<Record<string, unknown>>): void;
  copyFile(source: string, destination: string): void;
  publish(candidate: string, databasePath: string): void;
  syncFile(path: string): void;
  syncDirectory(path: string): void;
}

interface RestoreInputSnapshot {
  invocation: ExecutionInvocation;
  applicationIdentityHash: string;
  backup: LegacyImportVerifiedBackup;
  assessment: LegacyImportRestoreAssessment;
  consent: LegacyImportRestoreAssessmentConsent;
}

interface ErasedLineage extends Record<string, DomainJsonValue> {
  schemaVersion: 1;
  applicationOperationId: string;
  applicationIdentityHash: string;
  applicationResultingProjectRevision: number;
  applicationResultingAuthorityEpoch: number;
}

interface RestoreFileIdentity extends Record<string, DomainJsonValue> {
  device: string;
  inode: string;
}

interface RestoreIntent extends Record<string, DomainJsonValue> {
  intentSchemaVersion: 1;
  requestHash: string;
  stage: "claimed" | "staged" | "recovery-staged" | "published" | "receipt-recorded";
  ownerPid: number;
  ownerProcessStartIdentity: string;
  ownerNonce: string;
  originalDatabaseDevice: string;
  originalDatabaseInode: string;
  candidateDatabaseDevice: string | null;
  candidateDatabaseInode: string | null;
  applicationOperationId: string;
  applicationIdentityHash: string;
  backupId: string;
  backupSha256: string;
  backupByteSize: number;
  backupSchemaVersion: number;
  backupProjectRevision: number;
  backupAuthorityEpoch: number;
  assessmentEvidenceHash: string;
  differenceHash: string;
  consentHash: string;
  erasedLineageHash: string;
  erasedLineageJson: string;
}

const activeRestoreOwners = new Set<string>();
let selfProcessStartIdentity: string | null | undefined;

function fail(
  code: LegacyImportLiveRestoreErrorCode,
  stage: LegacyImportLiveRestoreStage,
  message: string,
  retryable = false,
  evidence: Record<string, DomainJsonValue> = {},
  cause?: unknown,
): never {
  throw new LegacyImportLiveRestoreError(
    code,
    stage,
    message,
    retryable,
    evidence,
    cause === undefined ? undefined : { cause },
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === keys.length && keys.every((key) => (
    Object.hasOwn(descriptors, key)
    && Object.hasOwn(descriptors[key] ?? {}, "value")
    && descriptors[key]?.enumerable === true
  ));
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", `${field} must be one canonical SHA-256 digest`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", `${field} must be non-blank text`);
  }
  return value;
}

function normalizeInvocation(value: unknown): ExecutionInvocation {
  if (!isPlainRecord(value)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "invocation must be one exact object");
  }
  const required = ["idempotencyKey", "sourceTransport", "actorType"];
  const optional = ["actorId", "traceId", "turnId"];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || !required.every((key) => Object.hasOwn(descriptors, key))
    || !keys.every((key) => required.includes(key) || optional.includes(key))
    || keys.some((key) => !Object.hasOwn(descriptors[key] ?? {}, "value") || descriptors[key]?.enumerable !== true)
  ) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "invocation does not satisfy the exact contract");
  }
  const sourceTransport = descriptors["sourceTransport"]?.value;
  if (sourceTransport !== "internal" && sourceTransport !== "pi-tool" && sourceTransport !== "workflow-mcp") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "invocation source transport is invalid");
  }
  const optionalText = (field: "actorId" | "traceId" | "turnId"): string | undefined => {
    const descriptor = descriptors[field];
    return descriptor === undefined ? undefined : requireText(descriptor.value, `invocation.${field}`);
  };
  const actorId = optionalText("actorId");
  const traceId = optionalText("traceId");
  const turnId = optionalText("turnId");
  return {
    idempotencyKey: requireText(descriptors["idempotencyKey"]?.value, "invocation.idempotencyKey"),
    sourceTransport,
    actorType: requireText(descriptors["actorType"]?.value, "invocation.actorType"),
    ...(actorId === undefined ? {} : { actorId }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function snapshotInput(value: unknown): RestoreInputSnapshot {
  if (!hasExactDataKeys(value, [
    "invocation",
    "applicationIdentityHash",
    "backup",
    "assessment",
    "consent",
  ])) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "live restore input does not satisfy the exact v1 contract");
  }
  if (!isStrictLegacyImportData(value)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "live restore input must contain strict acyclic data");
  }
  let detached: Record<string, unknown>;
  try {
    detached = structuredClone(value);
  } catch (error) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "live restore input could not be detached", false, {}, error);
  }
  if (!isValidLegacyImportVerifiedBackup(detached["backup"])) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "backup does not satisfy the complete verified contract");
  }
  const consent = detached["consent"];
  if (!hasExactDataKeys(consent, [
    "consentSchemaVersion",
    "decision",
    "destructiveDatabaseRestore",
    "evidenceHash",
  ]) || consent["consentSchemaVersion"] !== LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION
    || consent["decision"] !== "proceed"
    || consent["destructiveDatabaseRestore"] !== true) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "explicit destructive restore Consent is required");
  }
  const assessment = detached["assessment"];
  if (!isPlainRecord(assessment) || assessment["assessmentSchemaVersion"] !== 1) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "assessment does not satisfy the v1 contract");
  }
  return deepFreeze({
    invocation: normalizeInvocation(detached["invocation"]),
    applicationIdentityHash: requireHash(detached["applicationIdentityHash"], "applicationIdentityHash"),
    backup: detached["backup"],
    assessment: assessment as unknown as LegacyImportRestoreAssessment,
    consent: {
      consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      destructiveDatabaseRestore: true,
      evidenceHash: requireHash(consent["evidenceHash"], "consent.evidenceHash"),
    },
  });
}

function hashFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function hashIntent(intent: RestoreIntent): string {
  return `sha256:${createHash("sha256").update(canonicalLegacyImportJson(intent)).digest("hex")}`;
}

function syncFile(path: string): void {
  // The sync pass opens read-write on Windows because fsync (FlushFileBuffers)
  // requires a handle with GENERIC_WRITE. POSIX keeps O_RDONLY (same convention
  // as legacy-import-backup.ts hashSnapshotPass).
  const access = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  const fd = openSync(path, access | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    // DURABILITY CAVEAT (macOS): Node's fsyncSync issues plain fsync(2). On
    // macOS fsync does not flush the drive's onboard write cache to stable
    // media — that requires fcntl(fd, F_FULLFSYNC, 0) (macOS only; Linux
    // fsync is already a full flush). The @gsd/native syncDirectoryEntry
    // binding used for directory syncs routes through Rust File::sync_all,
    // which Rust std lowers to fcntl(F_FULLFSYNC) on Apple platforms and
    // FlushFileBuffers on Windows — only these file-content syncs remain on
    // plain fsync. So on macOS the intent and candidate durability proven
    // here is process-crash-safe and kernel-crash-safe, but a power loss at
    // exactly the wrong instant could still lose the last synced
    // intent/candidate bytes. The crash-recovery design already tolerates
    // that (a lost intent re-drives convergence from durable receipts), so
    // strengthening this to F_FULLFSYNC — via a koffi fcntl binding mirroring
    // process-start-identity.ts, with a probe-and-fallback for filesystems
    // that return ENOTSUP — is a hardening follow-up rather than a
    // correctness fix.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") {
    syncDirectoryEntry(path);
    return;
  }
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function defaultDependencies(overrides: Partial<LiveRestoreDependencies>): LiveRestoreDependencies {
  return {
    copyFile(source, destination) {
      copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
    },
    publish: (candidate, databasePath) => renameSync(candidate, databasePath),
    syncFile,
    syncDirectory,
    ...overrides,
  };
}

function backupBase(backupPath: string): LegacyImportBaseSnapshot {
  const connection = openSqliteReadOnly(backupPath);
  try {
    return captureLegacyImportBaseSnapshot({
      readTransaction: (fn) => fn(),
      source: createLegacyImportBaseSnapshotSource(connection.db),
    });
  } finally {
    connection.db.close();
  }
}

function requireRegularFile(path: string, byteSize: number): void {
  const stat = lstatSync(path, { bigint: true });
  if (
    !isAbsolute(path)
    || realpathSync(path) !== path
    || !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size !== BigInt(byteSize)
  ) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "stage", "restore file identity is invalid");
  }
}

function requireDatabasePath(): string {
  const path = getDbPath();
  if (!path || path === ":memory:" || !isAbsolute(path)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "contract", "live restore requires the active file-backed database");
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("database path is not one regular file");
    return realpathSync(path);
  } catch (error) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "contract", "active database path is not one canonical regular path", false, {}, error);
  }
}

function requestHash(input: RestoreInputSnapshot): string {
  return hashLegacyImportValue({
    liveRestoreSchemaVersion: LEGACY_IMPORT_LIVE_RESTORE_SCHEMA_VERSION,
    invocation: input.invocation,
    applicationIdentityHash: input.applicationIdentityHash,
    backupId: input.backup.backup_id,
    backupSha256: input.backup.backup_sha256,
    backupByteSize: input.backup.backup_byte_size,
    assessmentEvidenceHash: input.assessment.evidenceHash,
    differenceHash: input.assessment.facts.difference?.differenceHash ?? null,
    consentHash: hashLegacyImportValue(input.consent),
  });
}

function erasedLineage(input: RestoreInputSnapshot): ErasedLineage {
  const applicationOperationId = input.assessment.facts.applicationOperationId;
  const applicationResultingProjectRevision = input.assessment.facts.applicationResultingProjectRevision;
  const applicationResultingAuthorityEpoch = input.assessment.facts.applicationResultingAuthorityEpoch;
  if (typeof applicationOperationId !== "string"
    || !Number.isSafeInteger(applicationResultingProjectRevision)
    || Number(applicationResultingProjectRevision) <= 0
    || !Number.isSafeInteger(applicationResultingAuthorityEpoch)
    || Number(applicationResultingAuthorityEpoch) < 0) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "eligible assessment lacks exact erased Application authority");
  }
  return {
    schemaVersion: 1,
    applicationOperationId,
    applicationIdentityHash: input.applicationIdentityHash,
    applicationResultingProjectRevision: Number(applicationResultingProjectRevision),
    applicationResultingAuthorityEpoch: Number(applicationResultingAuthorityEpoch),
  };
}

function intentFor(
  input: RestoreInputSnapshot,
  hash: string,
  lineage: ErasedLineage,
  originalDatabase: RestoreFileIdentity,
): RestoreIntent {
  const differenceHash = input.assessment.facts.difference?.differenceHash;
  if (typeof differenceHash !== "string") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE", "recheck", "eligible assessment lacks an exact difference digest");
  }
  return {
    intentSchemaVersion: INTENT_SCHEMA_VERSION,
    requestHash: hash,
    stage: "claimed",
    ownerPid: process.pid,
    ownerProcessStartIdentity: requireSelfProcessStartIdentity(),
    ownerNonce: randomUUID(),
    originalDatabaseDevice: originalDatabase.device,
    originalDatabaseInode: originalDatabase.inode,
    candidateDatabaseDevice: null,
    candidateDatabaseInode: null,
    applicationOperationId: lineage.applicationOperationId,
    applicationIdentityHash: input.applicationIdentityHash,
    backupId: input.backup.backup_id,
    backupSha256: input.backup.backup_sha256,
    backupByteSize: input.backup.backup_byte_size,
    backupSchemaVersion: input.backup.backup_database_schema_version,
    backupProjectRevision: input.backup.base_project_revision,
    backupAuthorityEpoch: input.backup.base_authority_epoch,
    assessmentEvidenceHash: input.assessment.evidenceHash,
    differenceHash,
    consentHash: hashLegacyImportValue(input.consent),
    erasedLineageHash: hashLegacyImportValue(lineage),
    erasedLineageJson: canonicalLegacyImportJson(lineage),
  };
}

function fileIdentity(path: string, label: string): RestoreFileIdentity {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "converge", `cannot inspect ${label}`, false, {}, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "converge", `${label} must be one regular file`);
  }
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function sameFileIdentity(left: RestoreFileIdentity, right: RestoreFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function intentOriginalFileIdentity(intent: RestoreIntent): RestoreFileIdentity {
  return { device: intent.originalDatabaseDevice, inode: intent.originalDatabaseInode };
}

function intentCandidateFileIdentity(intent: RestoreIntent): RestoreFileIdentity | null {
  return intent.candidateDatabaseDevice === null || intent.candidateDatabaseInode === null
    ? null
    : { device: intent.candidateDatabaseDevice, inode: intent.candidateDatabaseInode };
}

function writeIntent(path: string, intent: RestoreIntent, syncDir: (path: string) => void): void {
  const current = readIntent(path);
  if (current === null) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "restore intent ownership changed before update");
  }
  requireMatchingIntent(current, intent);
  requireSameIntentOwner(current, intent);
  const transition = `${current.stage}->${intent.stage}`;
  if (transition !== "claimed->staged"
    && transition !== "staged->recovery-staged"
    && transition !== "published->recovery-staged"
    && transition !== "recovery-staged->published"
    && transition !== "staged->published"
    && transition !== "published->receipt-recorded") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "restore intent attempted an invalid state transition");
  }
  const currentCandidate = intentCandidateFileIdentity(current);
  const nextCandidate = intentCandidateFileIdentity(intent);
  const stagesRecoveryCandidate = transition === "staged->recovery-staged"
    || transition === "published->recovery-staged";
  if ((current.stage === "claimed" && nextCandidate === null)
    || (stagesRecoveryCandidate && (currentCandidate === null || nextCandidate === null))
    || (current.stage !== "claimed" && !stagesRecoveryCandidate && (
      currentCandidate === null
      || nextCandidate === null
      || !sameFileIdentity(currentCandidate, nextCandidate)
    ))) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "restore intent candidate identity changed during update");
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, canonicalLegacyImportJson(intent), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDir(dirname(path));
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain original error */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* retain original error */ }
    throw error;
  }
}

function systemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

function requireSelfProcessStartIdentity(): string {
  if (selfProcessStartIdentity === undefined) {
    selfProcessStartIdentity = processStartIdentity(process.pid);
  }
  if (selfProcessStartIdentity === null) {
    fail(
      "LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID",
      "contract",
      "live restore cannot prove the current process start identity",
    );
  }
  return selfProcessStartIdentity;
}

function intentOwnerIsActive(intent: RestoreIntent): boolean {
  if (intent.ownerPid === process.pid) return activeRestoreOwners.has(intent.ownerNonce);
  try {
    process.kill(intent.ownerPid, 0);
  } catch (error) {
    if (systemErrorCode(error) === "ESRCH") return false;
  }
  const currentIdentity = processStartIdentity(intent.ownerPid);
  return currentIdentity === null || currentIdentity === intent.ownerProcessStartIdentity;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "converge", "cannot inspect restore recovery entry", false, {}, error);
  }
}

function claimIntent(path: string, intent: RestoreIntent, ops: LiveRestoreDependencies): boolean {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  let linkAttempted = false;
  let published = false;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(fd, canonicalLegacyImportJson(intent), "utf8");
    ops.boundary?.("after-claim-write");
    fsyncSync(fd);
    ops.boundary?.("after-claim-file-sync");
    closeSync(fd);
    fd = undefined;
    linkAttempted = true;
    linkSync(temporary, path);
    published = true;
    ops.boundary?.("after-claim-publish");
    ops.syncDirectory(dirname(path));
    ops.boundary?.("after-claim-directory-sync");
    unlinkSync(temporary);
    ops.syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain original error */ }
    }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* retain original error */ }
    if (!published && linkAttempted && systemErrorCode(error) === "EEXIST") return false;
    throw error;
  }
}

function intentIdentity(intent: RestoreIntent): string {
  const {
    stage: _stage,
    ownerPid: _ownerPid,
    ownerProcessStartIdentity: _ownerProcessStartIdentity,
    ownerNonce: _ownerNonce,
    originalDatabaseDevice: _originalDatabaseDevice,
    originalDatabaseInode: _originalDatabaseInode,
    candidateDatabaseDevice: _candidateDatabaseDevice,
    candidateDatabaseInode: _candidateDatabaseInode,
    ...identity
  } = intent;
  return canonicalLegacyImportJson(identity);
}

function requireMatchingIntent(actual: RestoreIntent, expected: RestoreIntent): void {
  if (actual.requestHash !== expected.requestHash || intentIdentity(actual) !== intentIdentity(expected)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent does not match the approved request");
  }
}

function requireSameIntentOwner(actual: RestoreIntent, expected: RestoreIntent): void {
  if (actual.ownerPid !== expected.ownerPid
    || actual.ownerProcessStartIdentity !== expected.ownerProcessStartIdentity
    || actual.ownerNonce !== expected.ownerNonce
    || !sameFileIdentity(intentOriginalFileIdentity(actual), intentOriginalFileIdentity(expected))) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent owner changed");
  }
}

function readIntent(path: string): RestoreIntent | null {
  if (!existsSync(path)) return null;
  const directoryPath = dirname(path);
  let fd: number | undefined;
  let serialized: string;
  try {
    const directory = lstatSync(directoryPath, { bigint: true });
    const before = lstatSync(path, { bigint: true });
    if (realpathSync(directoryPath) !== directoryPath
      || !directory.isDirectory()
      || directory.isSymbolicLink()
      || realpathSync(path) !== path
      || !before.isFile()
      || before.isSymbolicLink()) {
      throw new Error("restore intent path is not one owned regular file");
    }
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("restore intent identity changed before read");
    }
    serialized = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("restore intent identity changed during read");
    }
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* retain original error */ }
    }
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent path is unsafe", false, {}, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent is malformed", false, {}, error);
  }
  const required = [
    "intentSchemaVersion", "requestHash", "stage", "ownerPid", "ownerProcessStartIdentity", "ownerNonce",
    "originalDatabaseDevice", "originalDatabaseInode",
    "candidateDatabaseDevice", "candidateDatabaseInode", "applicationOperationId",
    "applicationIdentityHash", "backupId", "backupSha256", "backupByteSize",
    "backupSchemaVersion", "backupProjectRevision", "backupAuthorityEpoch",
    "assessmentEvidenceHash", "differenceHash", "consentHash", "erasedLineageHash",
    "erasedLineageJson",
  ];
  if (!hasExactDataKeys(value, required)
    || value["intentSchemaVersion"] !== INTENT_SCHEMA_VERSION
    || (value["stage"] !== "claimed" && value["stage"] !== "staged"
      && value["stage"] !== "recovery-staged"
      && value["stage"] !== "published" && value["stage"] !== "receipt-recorded")) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent does not satisfy the exact contract");
  }
  for (const field of [
    "requestHash", "applicationIdentityHash", "backupId", "backupSha256",
    "assessmentEvidenceHash", "differenceHash", "consentHash", "erasedLineageHash",
  ]) requireHash(value[field], `intent.${field}`);
  requireHash(value["ownerProcessStartIdentity"], "intent.ownerProcessStartIdentity");
  if (typeof value["applicationOperationId"] !== "string"
    || value["applicationOperationId"].trim().length === 0
    || !Number.isSafeInteger(value["ownerPid"])
    || Number(value["ownerPid"]) <= 0
    || typeof value["ownerNonce"] !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value["ownerNonce"])
    || typeof value["originalDatabaseDevice"] !== "string"
    || !/^\d+$/.test(value["originalDatabaseDevice"])
    || typeof value["originalDatabaseInode"] !== "string"
    || !/^[1-9]\d*$/.test(value["originalDatabaseInode"])
    || typeof value["erasedLineageJson"] !== "string"
    || !Number.isSafeInteger(value["backupByteSize"])
    || Number(value["backupByteSize"]) <= 0
    || !Number.isSafeInteger(value["backupSchemaVersion"])
    || Number(value["backupSchemaVersion"]) <= 0
    || !Number.isSafeInteger(value["backupProjectRevision"])
    || Number(value["backupProjectRevision"]) < 0
    || !Number.isSafeInteger(value["backupAuthorityEpoch"])
    || Number(value["backupAuthorityEpoch"]) < 0) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent contains invalid scalar evidence");
  }
  const candidateDevice = value["candidateDatabaseDevice"];
  const candidateInode = value["candidateDatabaseInode"];
  const candidateAbsent = candidateDevice === null && candidateInode === null;
  const candidatePresent = typeof candidateDevice === "string"
    && /^\d+$/.test(candidateDevice)
    && typeof candidateInode === "string"
    && /^[1-9]\d*$/.test(candidateInode);
  if ((!candidateAbsent && !candidatePresent)
    || (value["stage"] === "claimed" && !candidateAbsent)
    || (value["stage"] !== "claimed" && !candidatePresent)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent candidate evidence is inconsistent");
  }
  let lineage: unknown;
  try { lineage = JSON.parse(String(value["erasedLineageJson"])); } catch { lineage = null; }
  if (!isPlainRecord(lineage)
    || canonicalLegacyImportJson(lineage) !== value["erasedLineageJson"]
    || hashLegacyImportValue(lineage) !== value["erasedLineageHash"]
    || lineage["schemaVersion"] !== 1
    || lineage["applicationOperationId"] !== value["applicationOperationId"]
    || lineage["applicationIdentityHash"] !== value["applicationIdentityHash"]
    || lineage["applicationResultingProjectRevision"] !== Number(value["backupProjectRevision"]) + 1
    || lineage["applicationResultingAuthorityEpoch"] !== value["backupAuthorityEpoch"]) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "active restore intent erased lineage is inconsistent");
  }
  return deepFreeze(value as unknown as RestoreIntent);
}

export function retainedLegacyImportRestoreOperationId(): string | null {
  const intent = readIntent(getDatabaseReplacementPaths(requireDatabasePath()).activeIntentPath);
  return intent?.applicationOperationId ?? null;
}

export function assertRetainedLegacyImportRestoreIntent(
  applicationOperationId: string,
  applicationIdentityHash: string,
  backup: Readonly<LegacyImportVerifiedBackup>,
  approval: {
    readonly assessment: Readonly<LegacyImportRestoreAssessment>;
    readonly consent: Readonly<LegacyImportRestoreAssessmentConsent>;
  },
): void {
  const intent = readIntent(getDatabaseReplacementPaths(requireDatabasePath()).activeIntentPath);
  if (intent === null
    || intent.applicationOperationId !== applicationOperationId
    || intent.applicationIdentityHash !== applicationIdentityHash
    || intent.backupId !== backup.backup_id
    || intent.backupSha256 !== backup.backup_sha256
    || intent.backupByteSize !== backup.backup_byte_size
    || intent.backupSchemaVersion !== backup.backup_database_schema_version
    || intent.backupProjectRevision !== backup.base_project_revision
    || intent.backupAuthorityEpoch !== backup.base_authority_epoch
    || intent.assessmentEvidenceHash !== approval.assessment.evidenceHash
    || intent.differenceHash !== approval.assessment.facts.difference?.differenceHash
    || intent.consentHash !== hashLegacyImportValue(approval.consent)) {
    fail(
      "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
      "converge",
      "active restore intent does not match the retained Import Application",
    );
  }
}

function ensureRecoveryDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path, { bigint: true });
  if (realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "stage", "restore recovery directory is invalid");
  }
}

function pathsReferenceSameFile(firstPath: string, secondPath: string): boolean {
  try {
    const first = lstatSync(firstPath, { bigint: true });
    const second = lstatSync(secondPath, { bigint: true });
    return first.isFile()
      && second.isFile()
      && !first.isSymbolicLink()
      && !second.isSymbolicLink()
      && first.dev === second.dev
      && first.ino === second.ino;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "converge", "cannot compare restore recovery entries", false, {}, error);
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
  }
}

function cleanupRecoveryDirectory(
  path: string,
  expectedIntent: RestoreIntent,
  ops: LiveRestoreDependencies,
): boolean {
  if (!existsSync(path)) return false;
  const activeIntentPath = join(path, INTENT_FILE);
  const claimPath = join(path, `${RECOVERY_CLAIM_PREFIX}${process.pid}-${randomUUID()}`);
  let ownsClaim = false;
  try {
    try {
      linkSync(activeIntentPath, claimPath);
      ownsClaim = true;
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") return false;
      throw error;
    }
    ops.boundary?.("after-cleanup-claim-link");
    ops.syncDirectory(path);

    const claimedIntent = readIntent(claimPath);
    if (claimedIntent === null) return false;
    requireMatchingIntent(claimedIntent, expectedIntent);
    requireSameIntentOwner(claimedIntent, expectedIntent);
    const callerOwnsIntent = claimedIntent.ownerPid === process.pid
      && activeRestoreOwners.has(claimedIntent.ownerNonce);
    if (!callerOwnsIntent && intentOwnerIsActive(claimedIntent)) return false;
    if (!pathsReferenceSameFile(activeIntentPath, claimPath)) return false;
    ops.boundary?.("after-cleanup-claim-verify");

    const stat = lstatSync(path, { bigint: true });
    if (realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "restore recovery directory ownership changed");
    }
    const entries = readdirSync(path);
    const concurrentClaims: string[] = [];
    for (const entry of entries) {
      const entryPath = join(path, entry);
      const allowed = entry === INTENT_FILE
        || entry === CANDIDATE_FILE
        || entry.startsWith(`${INTENT_FILE}.tmp-`)
        || entry.startsWith(RECOVERY_CLAIM_PREFIX);
      if (!allowed) {
        fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "restore recovery directory contains an unknown entry");
      }
      let entryStat;
      try {
        entryStat = lstatSync(entryPath, { bigint: true });
      } catch (error) {
        if (systemErrorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
        fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "restore recovery entry changed kind");
      }
      if (entry === INTENT_FILE || entryPath === claimPath) continue;
      if (entry.startsWith(RECOVERY_CLAIM_PREFIX) && pathsReferenceSameFile(entryPath, claimPath)) {
        concurrentClaims.push(entryPath);
        continue;
      }
      unlinkIfPresent(entryPath);
    }
    ops.boundary?.("after-cleanup-entries");

    if (!callerOwnsIntent && intentOwnerIsActive(claimedIntent)) return false;
    if (!pathsReferenceSameFile(activeIntentPath, claimPath)) return false;
    unlinkSync(activeIntentPath);
    ops.boundary?.("after-cleanup-intent");

    for (const concurrentClaim of concurrentClaims) unlinkIfPresent(concurrentClaim);
    unlinkIfPresent(claimPath);
    ownsClaim = false;
    ops.boundary?.("after-cleanup-claim-unlink");
    let removedDirectory = false;
    try {
      rmdirSync(path);
      removedDirectory = true;
    } catch (error) {
      const code = systemErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
    ops.boundary?.("after-cleanup-directory", { removedDirectory });
    ops.syncDirectory(dirname(path));
    return true;
  } finally {
    if (ownsClaim) unlinkIfPresent(claimPath);
  }
}

function cleanupTerminalRecoveryDirectory(path: string, ops: LiveRestoreDependencies): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path, { bigint: true });
  if (realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "terminal restore recovery directory is not empty");
  }
  for (const entry of readdirSync(path)) {
    if (!entry.startsWith(RECOVERY_CLAIM_PREFIX)) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "terminal restore recovery directory is not empty");
    }
    const entryPath = join(path, entry);
    let entryStat;
    try {
      entryStat = lstatSync(entryPath);
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "terminal restore recovery claim changed kind");
    }
    unlinkIfPresent(entryPath);
  }
  try {
    rmdirSync(path);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
  }
  ops.syncDirectory(dirname(path));
}

function removeLiveSidecars(databasePath: string, boundary?: LiveRestoreDependencies["boundary"]): void {
  const sidecars = [
    ["-wal", "after-wal-removal"],
    ["-shm", "after-shm-removal"],
    ["-journal", "after-journal-removal"],
  ] as const;
  for (const [suffix, removedBoundary] of sidecars) {
    const path = `${databasePath}${suffix}`;
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") {
        boundary?.(removedBoundary, { suffix });
        continue;
      }
      fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "publish", "cannot inspect live SQLite sidecar", false, {}, error);
    }
    if (!stat.isSymbolicLink() && !stat.isFile()) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "publish", "live SQLite sidecar is not a regular owned file");
    }
    unlinkSync(path);
    boundary?.(removedBoundary, { suffix });
  }
}

function requireFreshEligibleAssessment(input: RestoreInputSnapshot): void {
  const fresh = assessLegacyImportRestore({
    applicationIdentityHash: input.applicationIdentityHash,
    backup: input.backup,
    consent: input.consent,
  });
  if (fresh.decision !== "restore-eligible") {
    fail(
      "LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE",
      "recheck",
      "live restore requires a fresh eligible assessment",
      fresh.retryable,
      { decision: fresh.decision, reasonCode: fresh.reasonCode },
    );
  }
  if (canonicalLegacyImportJson(fresh) !== canonicalLegacyImportJson(input.assessment)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_ASSESSMENT_CHANGED", "recheck", "supplied eligible assessment is stale or changed", true);
  }
}

function isSqliteWriterContention(error: unknown): boolean {
  const code = systemErrorCode(error) ?? "";
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error);
  return code.includes("SQLITE_BUSY") || /SQLITE_BUSY|database is locked/iu.test(message);
}

/**
 * detachActiveDatabaseForReplacement() reports WAL checkpoint and journal-mode
 * contention as GSD_STALE_STATE rather than SQLITE_BUSY. A checkpoint that
 * observed busy != 0, or a journal mode that stayed WAL because another
 * connection holds the database, is the same transient contention recognized
 * at claim time, so it must classify as retryable here too. A checkpoint that
 * ran (busy = 0) but returned inconsistent frame counts is a genuine
 * invariant failure and stays non-retryable.
 */
function isTransientDetachContention(error: unknown): boolean {
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error);
  const checkpoint = /requires a complete TRUNCATE checkpoint; observed (\d+)\//u.exec(message);
  if (checkpoint !== null) return checkpoint[1] !== "0";
  return /requires DELETE journal mode before detach; observed wal/iu.test(message);
}

function verifyCandidate(
  input: RestoreInputSnapshot,
  application: LegacyImportApplicationEvidence,
  candidatePath: string,
): void {
  requireRegularFile(candidatePath, input.backup.backup_byte_size);
  if (hashFile(candidatePath) !== input.backup.backup_sha256) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_STAGE_FAILED", "stage", "staged candidate bytes do not match the verified backup");
  }
  const base = backupBase(candidatePath);
  verifyLegacyImportBackupArtifact({
    backup: { ...input.backup, backup_ref: candidatePath },
    preview: application.preview,
    base,
  });
}

function verifyOpenDatabaseIntegrity(boundary?: LiveRestoreDependencies["boundary"]): LegacyImportBaseSnapshot {
  const db = getDb();
  const exactlyOk = (pragma: "quick_check" | "integrity_check"): void => {
    const rows = db.prepare(`PRAGMA ${pragma}`).all();
    if (rows.length !== 1 || rows[0]?.[pragma] !== "ok") {
      fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", `installed database failed ${pragma}`);
    }
  };
  exactlyOk("quick_check");
  boundary?.("after-quick-check");
  exactlyOk("integrity_check");
  boundary?.("after-integrity-check");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "installed database has foreign-key violations");
  }
  boundary?.("after-foreign-key-check");
  const base = captureCurrentLegacyImportBaseSnapshot();
  boundary?.("after-base-verification");
  return base;
}

function verificationForBase(
  base: LegacyImportBaseSnapshot,
  installedDatabaseSha256: string,
): LegacyImportLiveRestoreVerification {
  const representativeRows = base.rows.filter((row) => (
    row.row_set === "milestones" || row.row_set === "slices" || row.row_set === "tasks"
  ));
  return deepFreeze({
    verificationSchemaVersion: 1,
    installedDatabaseSha256,
    relevantRowsHash: base.relevant_rows_hash,
    representativeRowsHash: hashLegacyImportValue(representativeRows),
    quickCheck: "ok",
    integrityCheck: "ok",
    foreignKeyViolations: 0,
  });
}

function verifyPublishedDatabaseFile(input: RestoreInputSnapshot, databasePath: string): string {
  requireRegularFile(databasePath, input.backup.backup_byte_size);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      lstatSync(sidecarPath);
      fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "published database has an unexpected SQLite sidecar");
    } catch (error) {
      if (error instanceof LegacyImportLiveRestoreError) throw error;
      if (systemErrorCode(error) !== "ENOENT") {
        fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "verify", "cannot inspect published SQLite sidecar", false, {}, error);
      }
    }
  }
  const installedDatabaseSha256 = hashFile(databasePath);
  if (installedDatabaseSha256 !== input.backup.backup_sha256) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "published database bytes do not match the approved backup");
  }
  return installedDatabaseSha256;
}

function verifyInstalledDatabase(
  input: RestoreInputSnapshot,
  installedDatabaseSha256: string,
  boundary?: LiveRestoreDependencies["boundary"],
): LegacyImportLiveRestoreVerification {
  const base = verifyOpenDatabaseIntegrity(boundary);
  if (
    base.authority.project_id !== input.backup.project_id
    || base.authority.project_root_realpath !== input.backup.project_root_realpath
    || base.authority.revision !== input.backup.base_project_revision
    || base.authority.authority_epoch !== input.backup.base_authority_epoch
    || base.database_schema_version !== input.backup.backup_database_schema_version
    || base.relevant_rows_hash !== input.backup.relevant_rows_hash
    || installedDatabaseSha256 !== input.backup.backup_sha256
  ) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "installed database does not match the approved backup base");
  }
  return verificationForBase(base, installedDatabaseSha256);
}

function strictCheckpointAfterReceipt(): void {
  const row = getDb().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const busy = Number(row?.["busy"] ?? -1);
  const log = Number(row?.["log"] ?? Number.NaN);
  const checkpointed = Number(row?.["checkpointed"] ?? Number.NaN);
  if (busy !== 0 || !Number.isSafeInteger(log) || !Number.isSafeInteger(checkpointed)
    || !((log === -1 && checkpointed === -1) || (log >= 0 && checkpointed === log))) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CHECKPOINT_FAILED", "checkpoint", "restore receipt checkpoint did not complete", true);
  }
}

function loadStoredResult(
  input: RestoreInputSnapshot,
  verification: LegacyImportLiveRestoreVerification,
  status: "committed" | "replayed",
): LegacyImportLiveRestoreResult {
  const row = getDb().prepare(`
    SELECT receipt.*, operation.operation_type
    FROM workflow_import_restores receipt
    JOIN workflow_operations operation USING (operation_id)
    WHERE receipt.application_identity_hash = :identity
  `).get({ ":identity": input.applicationIdentityHash });
  if (!row || row["operation_type"] !== "import.restore") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED", "receipt", "durable restore receipt is missing");
  }
  const operationId = String(row["operation_id"]);
  const eventIds = getDb().prepare(`
    SELECT event_id FROM workflow_domain_events WHERE operation_id = :operation_id ORDER BY event_index
  `).all({ ":operation_id": operationId }).map((entry) => String(entry["event_id"]));
  const outboxIds = getDb().prepare(`
    SELECT outbox_id FROM workflow_outbox WHERE event_id IN (
      SELECT event_id FROM workflow_domain_events WHERE operation_id = :operation_id
    ) ORDER BY outbox_id
  `).all({ ":operation_id": operationId }).map((entry) => Number(entry["outbox_id"]));
  const projectionWorkIds = getDb().prepare(`
    SELECT projection_work_id FROM workflow_projection_work
    WHERE enqueue_operation_id = :operation_id ORDER BY projection_work_id
  `).all({ ":operation_id": operationId }).map((entry) => String(entry["projection_work_id"]));
  if (
    row["application_identity_hash"] !== input.applicationIdentityHash
    || row["backup_id"] !== input.backup.backup_id
    || row["backup_sha256"] !== input.backup.backup_sha256
    || row["difference_hash"] !== input.assessment.facts.difference?.differenceHash
    || row["consent_hash"] !== hashLegacyImportValue(input.consent)
    || row["verification_hash"] !== hashLegacyImportValue(verification)
    || eventIds.length !== 1
    || outboxIds.length !== 1
    || projectionWorkIds.length !== 1
  ) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED", "receipt", "durable restore receipt is inconsistent");
  }
  return deepFreeze({
    status,
    operationId,
    projectId: String(row["project_id"]),
    applicationOperationId: String(row["application_operation_id"]),
    applicationIdentityHash: String(row["application_identity_hash"]),
    backupId: String(row["backup_id"]),
    backupSha256: String(row["backup_sha256"]),
    differenceHash: String(row["difference_hash"]),
    consentHash: String(row["consent_hash"]),
    verificationHash: String(row["verification_hash"]),
    installedDatabaseSha256: verification.installedDatabaseSha256,
    resultingProjectRevision: Number(row["resulting_project_revision"]),
    resultingAuthorityEpoch: Number(row["resulting_authority_epoch"]),
    eventIds,
    outboxIds,
    projectionWorkIds,
    verification,
  });
}

function recordReceipt(
  input: RestoreInputSnapshot,
  intent: RestoreIntent,
  verification: LegacyImportLiveRestoreVerification,
  capability: DatabaseReplacementReceiptCapability,
  ops: LiveRestoreDependencies,
): LegacyImportLiveRestoreResult {
  const verificationHash = hashLegacyImportValue(verification);
  const receiptPayload = {
    applicationOperationId: intent.applicationOperationId,
    applicationIdentityHash: intent.applicationIdentityHash,
    applicationResultingProjectRevision: input.assessment.facts.applicationResultingProjectRevision!,
    applicationResultingAuthorityEpoch: input.assessment.facts.applicationResultingAuthorityEpoch!,
    erasedLineageHash: intent.erasedLineageHash,
    erasedLineageJson: intent.erasedLineageJson,
    previewId: input.backup.preview_id,
    previewHash: input.backup.preview_hash,
    backupId: input.backup.backup_id,
    backupSha256: input.backup.backup_sha256,
    backupByteSize: input.backup.backup_byte_size,
    backupSchemaVersion: input.backup.backup_database_schema_version,
    backupProjectRevision: input.backup.base_project_revision,
    backupAuthorityEpoch: input.backup.base_authority_epoch,
    differenceHash: intent.differenceHash,
    consentHash: intent.consentHash,
    verificationHash,
  };
  const operation = _executeImportRestoreDomainOperation(capability, {
    operationType: "import.restore",
    idempotencyKey: `import.restore/${intent.requestHash.slice("sha256:".length)}`,
    expectedRevision: input.backup.base_project_revision,
    expectedAuthorityEpoch: input.backup.base_authority_epoch,
    actorType: input.invocation.actorType,
    actorId: input.invocation.actorId,
    sourceTransport: input.invocation.sourceTransport,
    traceId: input.invocation.traceId,
    turnId: input.invocation.turnId,
    payload: receiptPayload,
  }, (context) => {
    insertImportRestoreReceipt(context, receiptPayload);
    ops.boundary?.("before-receipt-commit", { requestHash: intent.requestHash });
    return {
      events: [{
        eventType: "legacy-import.restored",
        entityType: "legacy-import",
        entityId: input.backup.preview_id,
        payload: receiptPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "legacy-import/restore",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  return loadStoredResult(input, verification, operation.status);
}

function existingTerminalResult(input: RestoreInputSnapshot): LegacyImportLiveRestoreResult | null {
  const assessment = assessLegacyImportRestore({
    applicationIdentityHash: input.applicationIdentityHash,
    backup: input.backup,
  });
  if (assessment.decision !== "already-restored") return null;
  const current = verifyOpenDatabaseIntegrity();
  if (
    current.authority.project_id !== input.backup.project_id
    || current.authority.project_root_realpath !== input.backup.project_root_realpath
    || current.authority.revision < input.backup.base_project_revision + 1
    || current.authority.authority_epoch < input.backup.base_authority_epoch
  ) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "recorded restore authority does not match the approved backup successor");
  }
  requireRegularFile(input.backup.backup_ref, input.backup.backup_byte_size);
  if (hashFile(input.backup.backup_ref) !== input.backup.backup_sha256) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "retained restore backup no longer matches its receipt");
  }
  const restoredBase = backupBase(input.backup.backup_ref);
  if (
    restoredBase.authority.project_id !== input.backup.project_id
    || restoredBase.authority.project_root_realpath !== input.backup.project_root_realpath
    || restoredBase.authority.revision !== input.backup.base_project_revision
    || restoredBase.authority.authority_epoch !== input.backup.base_authority_epoch
    || restoredBase.database_schema_version !== input.backup.backup_database_schema_version
    || restoredBase.relevant_rows_hash !== input.backup.relevant_rows_hash
  ) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "retained restore backup does not match its durable evidence");
  }
  const verification = verificationForBase(restoredBase, input.backup.backup_sha256);
  return loadStoredResult(input, verification, "replayed");
}

export function replayLegacyImportLiveRestore(
  value: Readonly<LegacyImportLiveRestoreReplayInput>,
): LegacyImportLiveRestoreResult {
  // The replay boundary enforces the same strict exact-keys contract as the
  // live restore boundary (snapshotInput): no extra top-level keys and an
  // exact evidence-bound Consent, so a hand-rolled replay envelope cannot
  // smuggle tolerated fields past validation.
  if (!hasExactDataKeys(value, [
    "applicationIdentityHash",
    "backup",
    "consent",
  ]) || !isStrictLegacyImportData(value) || !isValidLegacyImportVerifiedBackup(value["backup"])) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "live restore replay input is invalid");
  }
  const replayConsent = value["consent"];
  if (!hasExactDataKeys(replayConsent, [
    "consentSchemaVersion",
    "decision",
    "destructiveDatabaseRestore",
    "evidenceHash",
  ]) || replayConsent["consentSchemaVersion"] !== LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION
    || replayConsent["decision"] !== "proceed"
    || replayConsent["destructiveDatabaseRestore"] !== true) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONTRACT_INVALID", "contract", "durable restore replay requires the exact evidence-bound Consent");
  }
  requireHash(value["applicationIdentityHash"], "applicationIdentityHash");
  requireHash(replayConsent["evidenceHash"], "consent.evidenceHash");
  const assessment = assessLegacyImportRestore({
    applicationIdentityHash: value.applicationIdentityHash,
    backup: value.backup,
    consent: value.consent,
  });
  if (assessment.decision !== "already-restored") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE", "recheck", "durable restore replay is unavailable");
  }
  const row = getDb().prepare(`SELECT difference_hash, consent_hash
    FROM workflow_import_restores WHERE application_identity_hash = :identity`).get({
    ":identity": value.applicationIdentityHash,
  });
  if (typeof row?.["difference_hash"] !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(String(row["difference_hash"]))
    || row["consent_hash"] !== hashLegacyImportValue(value.consent)) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED", "receipt", "durable restore Consent is inconsistent");
  }
  const replayAssessment = {
    ...assessment,
    facts: { ...assessment.facts, difference: { differenceHash: row["difference_hash"] } },
  } as unknown as LegacyImportRestoreAssessment;
  const input = {
    invocation: { idempotencyKey: `legacy-import/recover-restore/${value.applicationIdentityHash}`, sourceTransport: "internal", actorType: "system", actorId: "gsd-recover" },
    applicationIdentityHash: value.applicationIdentityHash,
    backup: value.backup,
    assessment: replayAssessment,
    consent: value.consent,
  } as RestoreInputSnapshot;
  const result = existingTerminalResult(input);
  if (!result) fail("LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED", "receipt", "durable restore receipt is missing");
  return result;
}

function convergePublished(
  input: RestoreInputSnapshot,
  intent: RestoreIntent,
  databasePath: string,
  recoveryDirectory: string,
  activeIntentPath: string,
  ops: LiveRestoreDependencies,
  installedDatabaseSha256: string,
  capability: DatabaseReplacementReceiptCapability,
): LegacyImportLiveRestoreResult {
  const verification = verifyInstalledDatabase(input, installedDatabaseSha256, ops.boundary);
  const result = recordReceipt(input, intent, verification, capability, ops);
  ops.boundary?.("after-receipt", { operationId: result.operationId });
  const receiptRecorded = { ...intent, stage: "receipt-recorded" as const };
  writeIntent(activeIntentPath, receiptRecorded, ops.syncDirectory);
  ops.boundary?.("after-receipt-intent");
  strictCheckpointAfterReceipt();
  ops.boundary?.("after-receipt-checkpoint");
  ops.syncFile(databasePath);
  ops.boundary?.("after-database-sync");
  ops.syncDirectory(dirname(databasePath));
  const terminal = assessLegacyImportRestore({
    applicationIdentityHash: input.applicationIdentityHash,
    backup: input.backup,
  });
  if (terminal.decision !== "already-restored") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED", "receipt", "restore receipt did not pass strict terminal validation");
  }
  ops.boundary?.("after-terminal-assessment");
  if (!cleanupRecoveryDirectory(recoveryDirectory, intent, ops)) {
    fail(
      "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
      "converge",
      "restore cleanup lost its active intent",
      true,
      { requestHash: intent.requestHash },
    );
  }
  ops.boundary?.("after-cleanup");
  return result;
}

function convergeRecoveredPublication(
  input: RestoreInputSnapshot,
  intent: RestoreIntent,
  databasePath: string,
  recoveryDirectory: string,
  activeIntentPath: string,
  ops: LiveRestoreDependencies,
): LegacyImportLiveRestoreResult {
  const candidatePath = join(recoveryDirectory, CANDIDATE_FILE);
  let recoveryIntent = intent;
  let candidateIdentity = intentCandidateFileIdentity(intent);
  if (candidateIdentity === null) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "published recovery lacks candidate file identity");
  }
  const currentIdentity = fileIdentity(databasePath, "published recovery database");
  const liveMatchesIntent = sameFileIdentity(currentIdentity, candidateIdentity)
    && hashFile(databasePath) === input.backup.backup_sha256;
  let stagedCandidate = false;

  if (intent.stage === "recovery-staged") {
    if (pathEntryExists(candidatePath)) {
      requireRegularFile(candidatePath, input.backup.backup_byte_size);
      if (hashFile(candidatePath) !== input.backup.backup_sha256
        || !sameFileIdentity(fileIdentity(candidatePath, "recovery candidate"), candidateIdentity)) {
        fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "recovery candidate does not match its intent proof");
      }
      stagedCandidate = true;
    } else if (!liveMatchesIntent) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "recovery publication is missing its pinned candidate");
    }
  } else if (!liveMatchesIntent) {
    if (pathEntryExists(candidatePath)) {
      const staleCandidate = lstatSync(candidatePath, { bigint: true });
      if (!staleCandidate.isFile() || staleCandidate.isSymbolicLink()) {
        fail("LEGACY_IMPORT_LIVE_RESTORE_PATH_INVALID", "converge", "stale recovery candidate is not one owned file");
      }
      unlinkSync(candidatePath);
    }
    ops.copyFile(input.backup.backup_ref, candidatePath);
    ops.boundary?.("after-recovery-copy", { candidatePath });
    ops.syncFile(candidatePath);
    ops.boundary?.("after-recovery-sync", { candidatePath });
    requireRegularFile(candidatePath, input.backup.backup_byte_size);
    if (hashFile(candidatePath) !== input.backup.backup_sha256) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "recovery candidate bytes do not match the approved backup");
    }
    candidateIdentity = fileIdentity(candidatePath, "recovery candidate");
    recoveryIntent = {
      ...intent,
      stage: "recovery-staged",
      candidateDatabaseDevice: candidateIdentity.device,
      candidateDatabaseInode: candidateIdentity.inode,
    };
    writeIntent(activeIntentPath, recoveryIntent, ops.syncDirectory);
    ops.boundary?.("after-recovery-intent", { candidatePath });
    stagedCandidate = true;
  }

  let detached: DatabaseReplacementToken | undefined;
  let reopenEvidence: DatabaseReplacementReopenEvidence = stagedCandidate ? {} : {
    expectedPublishedSha256: input.backup.backup_sha256,
    persistedOriginalFileIdentity: intentOriginalFileIdentity(recoveryIntent),
    expectedPublishedFileIdentity: candidateIdentity,
    expectedActiveIntentFileIdentity: fileIdentity(activeIntentPath, "active restore intent"),
    expectedActiveIntentSha256: hashIntent(recoveryIntent),
  };
  try {
    detached = detachActiveDatabaseForReplacement(databasePath, ops.boundary);
    ops.boundary?.("after-detach");
    removeLiveSidecars(databasePath, ops.boundary);
    requireRegularFile(input.backup.backup_ref, input.backup.backup_byte_size);
    if (hashFile(input.backup.backup_ref) !== input.backup.backup_sha256) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_VERIFICATION_FAILED", "verify", "recovery backup bytes changed before convergence");
    }
    if (stagedCandidate) {
      ops.boundary?.("before-database-publish", { databasePath });
      ops.publish(candidatePath, databasePath);
      reopenEvidence = {
        expectedPublishedSha256: input.backup.backup_sha256,
        expectedPublishedFileIdentity: candidateIdentity,
        expectedActiveIntentFileIdentity: fileIdentity(activeIntentPath, "active restore intent"),
        expectedActiveIntentSha256: hashIntent(recoveryIntent),
      };
      ops.boundary?.("after-recovery-publish", { databasePath });
    }
    ops.syncFile(databasePath);
    ops.syncDirectory(dirname(databasePath));
    ops.boundary?.("after-live-parent-sync", { databasePath });
    const installedDatabaseSha256 = verifyPublishedDatabaseFile(input, databasePath);
    ops.boundary?.("after-published-file-verify", { databasePath });
    const publishedIntent = recoveryIntent.stage === "published"
      ? recoveryIntent
      : { ...recoveryIntent, stage: "published" as const };
    if (recoveryIntent.stage !== "published") {
      writeIntent(activeIntentPath, publishedIntent, ops.syncDirectory);
    }
    reopenEvidence = {
      expectedPublishedSha256: installedDatabaseSha256,
      ...(!stagedCandidate ? {
        persistedOriginalFileIdentity: intentOriginalFileIdentity(recoveryIntent),
      } : {}),
      expectedPublishedFileIdentity: candidateIdentity,
      expectedActiveIntentFileIdentity: fileIdentity(activeIntentPath, "active restore intent"),
      expectedActiveIntentSha256: hashIntent(publishedIntent),
    };
    ops.boundary?.("after-publish", { databasePath });
    const capability = reopenDatabaseAfterReplacement(detached, reopenEvidence, ops.boundary);
    detached = undefined;
    if (capability === null) {
      fail("LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED", "reopen", "recovered publication did not produce a receipt capability", true);
    }
    ops.boundary?.("after-reopen", { databasePath });
    return convergePublished(
      input,
      publishedIntent,
      databasePath,
      recoveryDirectory,
      activeIntentPath,
      ops,
      installedDatabaseSha256,
      capability,
    );
  } catch (error) {
    if (detached !== undefined) {
      try { reopenDatabaseAfterReplacement(detached, reopenEvidence, ops.boundary); } catch (reopenError) {
        fail(
          "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED",
          "reopen",
          "recovery verification could not reopen the published database",
          true,
          { requestHash: intent.requestHash },
          reopenError,
        );
      }
    }
    if (error instanceof LegacyImportLiveRestoreError) throw error;
    fail(
      "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED",
      "converge",
      "published restore requires exact retry convergence",
      true,
      { requestHash: intent.requestHash },
      error,
    );
  }
}

export function _restoreLegacyImportLiveForTest(
  value: unknown,
  overrides: Partial<LiveRestoreDependencies> = {},
): LegacyImportLiveRestoreResult {
  const input = snapshotInput(value);
  const ops = defaultDependencies(overrides);
  const databasePath = requireDatabasePath();
  const paths = getDatabaseReplacementPaths(databasePath);
  const recoveryDirectory = paths.recoveryDirectory;
  const activeIntentPath = paths.activeIntentPath;
  const candidatePath = join(recoveryDirectory, CANDIDATE_FILE);
  const hash = requestHash(input);
  const lineage = erasedLineage(input);
  const intent = intentFor(input, hash, lineage, fileIdentity(databasePath, "active database"));

  const active = readIntent(activeIntentPath);
  if (active !== null) {
    requireMatchingIntent(active, intent);
    promoteDatabaseForReplacementRecovery();
  }
  const terminal = existingTerminalResult(input);
  if (terminal !== null) {
    if (active !== null) {
      if (intentOwnerIsActive(active)) {
        fail(
          "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
          "converge",
          "the matching restore owner is still active",
          true,
          { requestHash: hash, stage: active.stage },
        );
      }
      strictCheckpointAfterReceipt();
      ops.syncFile(databasePath);
      ops.syncDirectory(dirname(databasePath));
      const durable = assessLegacyImportRestore({
        applicationIdentityHash: input.applicationIdentityHash,
        backup: input.backup,
      });
      if (durable.decision !== "already-restored") {
        fail("LEGACY_IMPORT_LIVE_RESTORE_RECEIPT_FAILED", "receipt", "terminal restore could not complete durable convergence");
      }
      if (!cleanupRecoveryDirectory(recoveryDirectory, active, ops)) {
        return _restoreLegacyImportLiveForTest(input, overrides);
      }
    } else {
      cleanupTerminalRecoveryDirectory(recoveryDirectory, ops);
    }
    return terminal;
  }

  if (active !== null) {
    if (intentOwnerIsActive(active)) {
      fail(
        "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
        "converge",
        "the matching restore owner is still active",
        true,
        { requestHash: hash, stage: active.stage },
      );
    }
    const current = captureCurrentLegacyImportBaseSnapshot();
    const installedBackup = current.authority.project_id === input.backup.project_id
      && current.authority.revision === input.backup.base_project_revision
      && current.authority.authority_epoch === input.backup.base_authority_epoch
      && current.relevant_rows_hash === input.backup.relevant_rows_hash;
    const currentIdentity = fileIdentity(databasePath, "active recovery database");
    const originalIdentity = intentOriginalFileIdentity(active);
    const candidateIdentity = intentCandidateFileIdentity(active);
    const stagedRecoveryCandidate = active.stage === "recovery-staged"
      && candidateIdentity !== null
      && pathEntryExists(candidatePath)
      && sameFileIdentity(fileIdentity(candidatePath, "recovery candidate"), candidateIdentity);
    if (sameFileIdentity(currentIdentity, originalIdentity)
      && (active.stage === "claimed" || active.stage === "staged")) {
      cleanupRecoveryDirectory(recoveryDirectory, active, ops);
      return _restoreLegacyImportLiveForTest(input, overrides);
    }
    if (stagedRecoveryCandidate || (installedBackup
      && candidateIdentity !== null
      && sameFileIdentity(currentIdentity, candidateIdentity)
      && active.stage !== "claimed")) {
      return convergeRecoveredPublication(
        input,
        active,
        databasePath,
        recoveryDirectory,
        activeIntentPath,
        ops,
      );
    }
    fail(
      "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
      "converge",
      "the same restore request is already staged by another owner",
      true,
      { requestHash: hash, stage: active.stage },
    );
  }

  requireFreshEligibleAssessment(input);
  const applicationOperationId = input.assessment.facts.applicationOperationId;
  if (typeof applicationOperationId !== "string") {
    fail("LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE", "recheck", "eligible assessment lacks the Application operation identity");
  }
  const application = inspectLegacyImportApplicationEvidence(applicationOperationId);
  if (application.applicationIdentityHash !== input.applicationIdentityHash) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE", "recheck", "Application identity changed before restore");
  }
  if (application.operationId !== lineage.applicationOperationId
    || application.resultingProjectRevision !== lineage.applicationResultingProjectRevision
    || application.resultingAuthorityEpoch !== lineage.applicationResultingAuthorityEpoch
    || application.backupId !== input.backup.backup_id
    || application.preview.preview.preview_id !== input.backup.preview_id
    || application.preview.preview_hash !== input.backup.preview_hash) {
    fail("LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE", "recheck", "Application evidence changed before restore");
  }

  let detached: DatabaseReplacementToken | undefined;
  let published = false;
  let ownsIntent = false;
  try {
    try {
      assertDatabaseMaintenanceAllowsReplacement(databasePath);
    } catch (error) {
      fail(
        "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
        "recheck",
        "database maintenance owns the replacement boundary",
        true,
        { requestHash: hash },
        error,
      );
    }
    immediateTransaction(() => {
      try {
        assertDatabaseMaintenanceAllowsReplacement(databasePath);
      } catch (error) {
        fail(
          "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
          "recheck",
          "database maintenance owns the replacement boundary",
          true,
          { requestHash: hash },
          error,
        );
      }
      ops.boundary?.("before-final-assessment");
      requireFreshEligibleAssessment(input);
      ops.boundary?.("after-final-assessment");
      ensureRecoveryDirectory(recoveryDirectory);
      ownsIntent = claimIntent(activeIntentPath, intent, ops);
      if (!ownsIntent) {
        const competing = readIntent(activeIntentPath);
        if (competing !== null) requireMatchingIntent(competing, intent);
        fail(
          "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
          "converge",
          "the same restore request acquired the replacement fence first",
          true,
          { requestHash: hash },
        );
      }
    });
    activeRestoreOwners.add(intent.ownerNonce);
    ops.boundary?.("after-intent", { requestHash: hash });
    ops.copyFile(input.backup.backup_ref, candidatePath);
    ops.boundary?.("after-candidate-copy", { candidatePath });
    ops.syncFile(candidatePath);
    ops.boundary?.("after-candidate-sync", { candidatePath });
    verifyCandidate(input, application, candidatePath);
    ops.boundary?.("after-candidate-verify", { candidatePath });
    const candidateIdentity = fileIdentity(candidatePath, "staged restore candidate");
    const stagedIntent: RestoreIntent = {
      ...intent,
      stage: "staged",
      candidateDatabaseDevice: candidateIdentity.device,
      candidateDatabaseInode: candidateIdentity.inode,
    };
    writeIntent(activeIntentPath, stagedIntent, ops.syncDirectory);
    ops.boundary?.("after-stage", { candidatePath });

    requireFreshEligibleAssessment(input);
    detached = detachActiveDatabaseForReplacement(databasePath, ops.boundary);
    removeLiveSidecars(databasePath, ops.boundary);
    ops.boundary?.("after-detach");
    ops.boundary?.("before-database-publish", { databasePath });
    ops.publish(candidatePath, databasePath);
    published = true;
    ops.boundary?.("after-database-publish", { databasePath });
    ops.syncDirectory(dirname(databasePath));
    ops.boundary?.("after-live-parent-sync", { databasePath });
    const installedDatabaseSha256 = verifyPublishedDatabaseFile(input, databasePath);
    ops.boundary?.("after-published-file-verify", { databasePath });
    const publishedIntent = { ...stagedIntent, stage: "published" as const };
    writeIntent(activeIntentPath, publishedIntent, ops.syncDirectory);
    ops.boundary?.("after-publish", { databasePath });

    const activeIntentIdentity = fileIdentity(activeIntentPath, "active restore intent");
    const receiptCapability = reopenDatabaseAfterReplacement(detached, {
      expectedPublishedSha256: installedDatabaseSha256,
      persistedOriginalFileIdentity: intentOriginalFileIdentity(publishedIntent),
      expectedPublishedFileIdentity: candidateIdentity,
      expectedActiveIntentFileIdentity: activeIntentIdentity,
      expectedActiveIntentSha256: hashIntent(publishedIntent),
    }, ops.boundary);
    if (receiptCapability === null) {
      fail(
        "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED",
        "reopen",
        "published restore reopened the original database file",
        true,
        { requestHash: hash },
      );
    }
    detached = undefined;
    ops.boundary?.("after-reopen", { databasePath });
    return convergePublished(
      input,
      publishedIntent,
      databasePath,
      recoveryDirectory,
      activeIntentPath,
      ops,
      installedDatabaseSha256,
      receiptCapability,
    );
  } catch (error) {
    if (detached !== undefined) {
      try {
        if (published) {
          removeLiveSidecars(databasePath, ops.boundary);
          const recoveryIntent = readIntent(activeIntentPath);
          if (recoveryIntent === null) {
            fail("LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT", "converge", "published restore lost its active intent");
          }
          requireMatchingIntent(recoveryIntent, intent);
          requireSameIntentOwner(recoveryIntent, intent);
          const candidateIdentity = intentCandidateFileIdentity(recoveryIntent);
          if (candidateIdentity === null) {
            fail("LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED", "converge", "published restore lost its candidate identity");
          }
          reopenDatabaseAfterReplacement(detached, {
            expectedPublishedSha256: input.backup.backup_sha256,
            persistedOriginalFileIdentity: intentOriginalFileIdentity(recoveryIntent),
            expectedPublishedFileIdentity: candidateIdentity,
            expectedActiveIntentFileIdentity: fileIdentity(activeIntentPath, "active restore intent"),
            expectedActiveIntentSha256: hashIntent(recoveryIntent),
          }, ops.boundary);
        } else {
          reopenDatabaseAfterReplacement(detached, {}, ops.boundary);
        }
        detached = undefined;
      } catch (reopenError) {
        fail(
          "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED",
          "reopen",
          published
            ? "published restore could not reopen for deterministic convergence"
            : "original database could not reopen after pre-publication failure",
          published,
          { requestHash: hash },
          reopenError,
        );
      }
    }
    if (!published && ownsIntent) {
      try { cleanupRecoveryDirectory(recoveryDirectory, intent, ops); } catch { /* surface original */ }
    }
    if (error instanceof LegacyImportLiveRestoreError) throw error;
    if (!published && (isSqliteWriterContention(error) || isTransientDetachContention(error))) {
      fail(
        "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
        ownsIntent ? "stage" : "recheck",
        ownsIntent
          ? "a concurrent database connection holds the active database while live restore is detaching it"
          : "a canonical writer owns the database while live restore is claiming authority",
        true,
        { requestHash: hash },
        error,
      );
    }
    fail(
      published
        ? "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED"
        : "LEGACY_IMPORT_LIVE_RESTORE_STAGE_FAILED",
      published ? "converge" : "stage",
      published
        ? "published restore requires exact retry convergence"
        : "live restore failed before publication",
      published,
      { requestHash: hash },
      error,
    );
  } finally {
    activeRestoreOwners.delete(intent.ownerNonce);
  }
}

export function restoreLegacyImportLive(value: unknown): LegacyImportLiveRestoreResult {
  return _restoreLegacyImportLiveForTest(value);
}
