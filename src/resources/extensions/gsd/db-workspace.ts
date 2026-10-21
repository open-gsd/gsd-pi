// Project/App: gsd-pi
// File Purpose: Workspace-facing Interface for opening and maintaining the workflow database.

import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { syncDirectoryEntry } from "@gsd/native/directory-sync";

import type { GsdWorkspace, MilestoneScope } from "./workspace.js";
import type { DbAdapter } from "./db-adapter.js";
import {
  checkpointDatabase,
  closeAllDatabases,
  closeDatabase,
  closeDatabaseByWorkspace,
  getDbPath,
  getDbStatus,
  getDbProvider,
  isDbAvailable,
  isSchemaTooNewError,
  _getAdapter,
  openDatabase,
  openExistingDatabase,
  openDatabaseByScope,
  openDatabaseByWorkspace,
  openIsolatedDatabase,
  refreshOpenDatabaseFromDisk,
  vacuumDatabase,
  wasDbOpenAttempted,
} from "./gsd-db.js";
import {
  applyLegacyImport,
  createLegacyImportApplicationConsent,
  type LegacyImportApplicationReceipt,
} from "./legacy-import-application.js";
import {
  prepareLegacyImportBackup,
  sealLegacyImportVerifiedBackup,
  verifyLegacyImportBackupArtifact,
  isValidLegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import {
  inspectLegacyImportApplicationEvidence,
  LegacyImportApplicationEvidenceError,
} from "./legacy-import-application-evidence.js";
import {
  captureCurrentLegacyImportBaseSnapshot,
  captureLegacyImportBaseSnapshot,
  createLegacyImportBaseSnapshotSource,
} from "./legacy-import-preview-base.js";
import {
  createLegacyImportPreview,
  hashLegacyImportValue,
  revalidateLegacyImportPreview,
  resolveLegacyImportPreview,
  type LegacyImportPreviewArtifact,
  type LegacyImportPreviewCreateInput,
  type LegacyImportPreviewResolutionChoice,
} from "./legacy-import-preview.js";
import { drillLegacyImportBackupRestore } from "./legacy-import-restore-drill.js";
import { inspectSqliteReadOnlySnapshot } from "./sqlite-readonly.js";
import { atomicWriteSync } from "./atomic-write.js";
import {
  assessLegacyImportRestore,
  type LegacyImportRestoreAssessment,
  type LegacyImportRestoreAssessmentConsent,
} from "./legacy-import-restore-assessment.js";
import {
  assertRetainedLegacyImportRestoreIntent,
  retainedLegacyImportRestoreOperationId,
} from "./legacy-import-live-restore.js";
import type { LegacyImportValue } from "./legacy-import-contract.js";
export {
  restoreLegacyImportLive,
  type LegacyImportLiveRestoreInput,
  type LegacyImportLiveRestoreResult,
} from "./legacy-import-live-restore.js";
import { resolveGsdPathContract, gsdRoot } from "./paths.js";
import { logWarning, setLogBasePath } from "./workflow-logger.js";
import { parseDecisionsTable } from "./decision-markdown-parser.js";
import { isSqliteBusyError } from "./sqlite-errors.js";

export interface WorkflowDatabaseLocation {
  projectRoot: string;
  projectGsd: string;
  projectDb: string;
}

export type WorkflowDatabaseOpenReason =
  | "opened-existing"
  | "created-empty"
  | "missing-database"
  | "missing-gsd-dir"
  | "locked"
  | "open-failed"
  | "schema-too-new";

export type WorkflowDatabaseOpenResult =
  | {
      ok: true;
      reason: "opened-existing" | "created-empty";
      location: WorkflowDatabaseLocation;
    }
  | {
      ok: false;
      reason: "missing-database" | "missing-gsd-dir" | "locked" | "open-failed";
      location: WorkflowDatabaseLocation;
      error?: Error;
    }
  | {
      // Refuse-newer version skew: the typed engine error (with its exact
      // message) is ALWAYS attached so read seams can surface it loudly.
      ok: false;
      reason: "schema-too-new";
      location: WorkflowDatabaseLocation;
      error: Error;
    };

export type WorkflowDatabaseStatus = ReturnType<typeof getDbStatus>;
export type WorkflowDatabaseProvider = ReturnType<typeof getDbProvider>;

/**
 * Global SQLite handle invariants:
 *
 * - `openWorkflowDatabase` / `openDatabase` switch the process-global handle consumed by
 *   deriveState, dispatch, reconciliation repairs, and domain writers. Only one active
 *   project database should own the global handle at a time.
 * - `openWorkflowDatabaseIsolated` opens a caller-owned connection that does not clobber
 *   the global handle. Use for read-only observers (parallel monitor) and other background
 *   probes that must not disturb the active workflow session.
 * - Reconciliation repairs that write markdown/DB state must use `ensureWorkflowDbForBase`
 *   so repairs target the correct project; those paths intentionally re-open the global handle.
 * - Pair ad-hoc project switches with `closeWorkflowDatabase()` or restore via
 *   `ensureWorkflowDbForBase(..., { refresh: true })` before returning to derive/dispatch.
 */
export function resolveWorkflowDatabaseLocation(basePath: string): WorkflowDatabaseLocation {
  const contract = resolveGsdPathContract(basePath);
  return {
    projectRoot: dirname(dirname(contract.projectDb)),
    projectGsd: contract.projectGsd,
    projectDb: contract.projectDb,
  };
}

/**
 * Resolve the correct DB path for the current working directory.
 * If `basePath` is inside a `.gsd/worktrees/<MID>/` directory, returns
 * the project root's `.gsd/gsd.db` (shared WAL — R012). Otherwise returns
 * `<basePath>/.gsd/gsd.db`.
 */
export function resolveProjectRootDbPath(basePath: string): string {
  return resolveWorkflowDatabaseLocation(basePath).projectDb;
}

function openWorkflowDatabaseWithMode(
  basePath: string,
  createIfMissing: boolean,
): WorkflowDatabaseOpenResult {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (!existsSync(location.projectGsd)) {
    return { ok: false, reason: "missing-gsd-dir", location };
  }

  const existed = existsSync(location.projectDb);
  if (!createIfMissing && !existed) {
    return { ok: false, reason: "missing-database", location };
  }
  try {
    const opened = createIfMissing
      ? openDatabase(location.projectDb)
      : openExistingDatabase(location.projectDb);
    if (!opened) {
      return { ok: false, reason: "open-failed", location };
    }
    setLogBasePath(location.projectRoot);
    return {
      ok: true,
      reason: existed ? "opened-existing" : "created-empty",
      location,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (isSchemaTooNewError(error)) {
      // Refuse-newer version skew stays distinguishable — never collapse it
      // into a generic open-failed that read seams degrade silently on.
      return {
        ok: false,
        reason: "schema-too-new",
        location,
        error,
      };
    }
    if (isSqliteBusyError(error)) {
      return {
        ok: false,
        reason: "locked",
        location,
        error,
      };
    }
    if (!createIfMissing && !existsSync(location.projectDb)) {
      return { ok: false, reason: "missing-database", location, error };
    }
    return {
      ok: false,
      reason: "open-failed",
      location,
      error,
    };
  }
}

export function openWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  return openWorkflowDatabaseWithMode(basePath, true);
}

export function openExistingWorkflowDatabase(basePath: string): WorkflowDatabaseOpenResult {
  return openWorkflowDatabaseWithMode(basePath, false);
}

export function openWorkflowDatabasePath(path: string): boolean {
  return openDatabase(path);
}

/**
 * Open an isolated database connection for read-only observation without
 * displacing the active workflow session's global DB handle. The caller is
 * responsible for calling `adapter.close()` when done.
 *
 * Use this for background observers (e.g. the parallel monitor overlay) that
 * need to query a database on a 5s tick without interfering with the primary
 * connection. Returns null if the connection cannot be opened.
 */
export function openWorkflowDatabaseIsolated(path: string): DbAdapter | null {
  return openIsolatedDatabase(path);
}

export function openWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): boolean {
  return openDatabaseByWorkspace(workspace);
}

export function openWorkflowDatabaseByScope(scope: MilestoneScope): boolean {
  return openDatabaseByScope(scope);
}

export function closeWorkflowDatabase(): void {
  closeDatabase();
}

export function closeWorkflowDatabaseByWorkspace(workspace: GsdWorkspace): void {
  closeDatabaseByWorkspace(workspace);
}

export function closeAllWorkflowDatabases(): void {
  closeAllDatabases();
}

export function isWorkflowDatabaseOpen(): boolean {
  return isDbAvailable();
}

export function wasWorkflowDatabaseOpenAttempted(): boolean {
  return wasDbOpenAttempted();
}

export function getWorkflowDatabaseStatus(): WorkflowDatabaseStatus {
  return getDbStatus();
}

export function getWorkflowDatabaseProvider(): WorkflowDatabaseProvider {
  return getDbProvider();
}

export function getWorkflowDatabasePath(): string | null {
  return getDbPath();
}

export function refreshWorkflowDatabaseFromDisk(): boolean {
  return refreshOpenDatabaseFromDisk();
}

export function expectedWorkflowDbPathForBase(basePath: string): string {
  return join(gsdRoot(basePath), "gsd.db");
}

export interface EnsureWorkflowDbOptions {
  /** When true, refresh from disk before reopening if already open on the correct path. */
  refresh?: boolean;
}

export function ensureWorkflowDbAtPath(dbPath: string | null): boolean {
  if (!dbPath || dbPath === ":memory:") return isDbAvailable();
  if (isDbAvailable() && getWorkflowDatabasePath() === dbPath) return true;
  if (!existsSync(dbPath)) return false;
  try {
    return openWorkflowDatabasePath(dbPath);
  } catch (err) {
    logWarning("reconcile", `ensureWorkflowDbAtPath could not reopen DB: ${(err as Error).message}`);
    return false;
  }
}

export function ensureWorkflowDbForBase(
  basePath: string,
  options: EnsureWorkflowDbOptions = {},
): boolean {
  const dbPath = expectedWorkflowDbPathForBase(basePath);
  if (!existsSync(dbPath)) return false;

  try {
    if (options.refresh) {
      if (isDbAvailable() && getWorkflowDatabasePath() === dbPath && refreshWorkflowDatabaseFromDisk()) {
        return true;
      }
      return openWorkflowDatabasePath(dbPath);
    }

    if (isDbAvailable() && getWorkflowDatabasePath() === dbPath) return true;
    return openWorkflowDatabasePath(dbPath);
  } catch (err) {
    logWarning("reconcile", `ensureWorkflowDbForBase could not reopen DB: ${(err as Error).message}`);
    return false;
  }
}

export function checkpointWorkflowDatabase(): void {
  checkpointDatabase();
}

export function vacuumWorkflowDatabase(): void {
  vacuumDatabase();
}

export interface PreparedVerifiedRecoverApplication {
  readonly basePath: string;
  readonly previewInput: LegacyImportPreviewCreateInput;
  readonly preview: LegacyImportPreviewArtifact;
  readonly authorizationText: string;
}

export interface VerifiedMigrationCounts {
  decisions: number;
  requirements: number;
  artifacts: number;
  hierarchy: {
    milestones: number;
    slices: number;
    tasks: number;
  };
  targets: readonly {
    targetKind: string;
    targetKey: string;
    contentHash: string;
  }[];
  application: {
    operationId: string;
    previewId: string;
    resultingRevision: number;
    resultingAuthorityEpoch: number;
    previewHash: string;
    sourceSetHash: string;
    changeSetHash: string;
    applicationRelevantRowsHash: string;
    projectionTargets: readonly {
      sourceId: string;
      logicalPath: string;
      sha256: string;
    }[];
    targets: readonly {
      targetKind: string;
      targetKey: string;
      contentHash: string;
    }[];
  };
}

export interface VerifiedMigrationArtifactEvidence {
  readonly logicalPath: string;
  readonly sha256: string;
}

export interface VerifiedRecoverApplicationResult {
  receipt: LegacyImportApplicationReceipt;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
  counts: {
    milestones: number;
    slices: number;
    tasks: number;
  };
  readonly restoreApproval?: VerifiedRecoverRestoreApproval;
}

export interface VerifiedRecoverRestoreApproval {
  readonly assessment: LegacyImportRestoreAssessment;
  readonly consent: LegacyImportRestoreAssessmentConsent;
}

function countRecoverRows(database: DbAdapter, table: "milestones" | "slices" | "tasks"): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"] ?? 0);
}

function requireVerifiedImportDatabase(basePath: string): void {
  const location = resolveWorkflowDatabaseLocation(basePath);
  const databasePath = getWorkflowDatabasePath();
  const canonicalDatabasePath = realpathSync(location.projectDb);
  if (
    !databasePath
    || databasePath === ":memory:"
    || realpathSync(databasePath) !== canonicalDatabasePath
  ) {
    throw new Error("verified import requires the open, file-backed project database");
  }
  if (databasePath !== canonicalDatabasePath && !openDatabase(canonicalDatabasePath)) {
    throw new Error("verified import could not reopen the canonical project database path");
  }
}

function prepareVerifiedImportPreview(
  basePath: string,
  previewInput: LegacyImportPreviewCreateInput,
): Pick<PreparedVerifiedRecoverApplication, "basePath" | "previewInput" | "preview"> {
  requireVerifiedImportDatabase(basePath);
  return { basePath, previewInput, preview: createLegacyImportPreview(previewInput) };
}

function revalidateVerifiedImportPreview(
  basePath: string,
  previewInput: LegacyImportPreviewCreateInput,
  expected: LegacyImportPreviewArtifact,
): LegacyImportPreviewArtifact {
  requireVerifiedImportDatabase(basePath);
  return revalidateLegacyImportPreview(previewInput, expected);
}

function prepareVerifiedImportEvidence(
  evidence: Pick<PreparedVerifiedRecoverApplication, "basePath" | "previewInput" | "preview">,
  label: string,
): {
  previewInput: LegacyImportPreviewCreateInput;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
} {
  const location = resolveWorkflowDatabaseLocation(evidence.basePath);
  const base = captureCurrentLegacyImportBaseSnapshot();
  const destinationDirectory = join(location.projectGsd, "backups");
  mkdirSync(destinationDirectory, { recursive: true });
  const backup = prepareLegacyImportBackup({
    preview: evidence.preview,
    base,
    roots: evidence.previewInput.roots,
    ...(evidence.previewInput.bundledDefinitionNames === undefined
      ? {}
      : { bundledDefinitionNames: evidence.previewInput.bundledDefinitionNames }),
    destination_directory: destinationDirectory,
    label,
  });
  drillLegacyImportBackupRestore({ backup, preview: evidence.preview, base });
  return { previewInput: evidence.previewInput, preview: evidence.preview, backup };
}

function recoverAuthorizationText(preview: LegacyImportPreviewArtifact): string {
  const counts = preview.preview.counts;
  return [
    `Import Preview ${preview.preview.preview_id}`,
    `Preview hash: ${preview.preview_hash}`,
    `Source set: ${preview.preview.source_set_hash}`,
    `Change set: ${preview.preview.change_set_hash}`,
    `Changes: ${counts.create} create, ${counts.update} update, ${counts.delete} delete, ${counts.preserve} preserve`,
    "Sources:",
    ...preview.preview.sources.map((source) => `  ${source.path} ${source.sha256} (${source.outcome})`),
    "Mappings:",
    ...preview.preview.changes.map((change) => (
      `  ${change.action} ${change.target.kind}:${change.target.key}`
      + (change.target.field === undefined ? "" : `#${change.target.field}`)
      + ` (${change.reason_code})`
      + `\n    Raw locator: ${JSON.stringify(change.raw.locator)}`
      + `\n    Raw value: ${JSON.stringify(change.raw.value)}`
      + `\n    Normalized value: ${JSON.stringify(change.normalized)}`
      + `\n    Provenance: ${JSON.stringify(change.provenance)}`
    )),
    "Diagnoses:",
    ...preview.preview.diagnoses.map((diagnosis) => `  ${JSON.stringify(diagnosis)}`),
    "Resolutions:",
    ...preview.preview.resolutions.map((resolution) => `  ${JSON.stringify(resolution)}`),
  ].join("\n");
}

function prepareVerifiedRecoverEvidence(basePath: string): PreparedVerifiedRecoverApplication {
  const location = resolveWorkflowDatabaseLocation(basePath);
  const evidence = prepareVerifiedImportPreview(basePath, {
    roots: [
      {
        id: "project-phases",
        kind: "project" as const,
        physical_path: join(location.projectGsd, "phases"),
        logical_path: ".gsd/phases",
        presence: "optional" as const,
      },
      {
        id: "project-milestones",
        kind: "project" as const,
        physical_path: join(location.projectGsd, "milestones"),
        logical_path: ".gsd/milestones",
        presence: "optional" as const,
      },
    ],
  });
  return { ...evidence, authorizationText: recoverAuthorizationText(evidence.preview) };
}

export function prepareVerifiedRecoverApplication(basePath: string): PreparedVerifiedRecoverApplication {
  return prepareVerifiedRecoverEvidence(basePath);
}

export function resolvePreparedVerifiedRecoverApplication(
  evidence: Readonly<PreparedVerifiedRecoverApplication>,
  choices: readonly LegacyImportPreviewResolutionChoice[],
): PreparedVerifiedRecoverApplication {
  const preview = resolveLegacyImportPreview(evidence.preview, choices);
  return { ...evidence, preview, authorizationText: recoverAuthorizationText(preview) };
}

export function prepareVerifiedRecoverBackup(basePath: string): LegacyImportVerifiedBackup {
  const evidence = prepareVerifiedRecoverEvidence(basePath);
  return prepareVerifiedImportEvidence(
    prepareVerifiedImportPreview(basePath, evidence.previewInput),
    "pre-recover",
  ).backup;
}

function requireApprovedRecoverPreview(
  preview: LegacyImportPreviewArtifact,
  approvedPreviewHash: string,
): void {
  if (approvedPreviewHash !== preview.preview_hash) {
    throw new Error("gsd recover approval does not match the sealed Import Preview");
  }
}

export function applyPreparedVerifiedRecoverApplication(
  evidence: Readonly<PreparedVerifiedRecoverApplication>,
  approvedPreviewHash: string,
): VerifiedRecoverApplicationResult {
  requireApprovedRecoverPreview(evidence.preview, approvedPreviewHash);
  const current = revalidateVerifiedImportPreview(
    evidence.basePath,
    evidence.previewInput,
    evidence.preview,
  );
  requireApprovedRecoverPreview(current, approvedPreviewHash);
  const backupPreview = revalidateVerifiedImportPreview(
    evidence.basePath,
    evidence.previewInput,
    evidence.preview,
  );
  const prepared = prepareVerifiedImportEvidence(
    { ...evidence, preview: backupPreview },
    "pre-recover",
  );
  requireApprovedRecoverPreview(prepared.preview, approvedPreviewHash);
  const finalPreview = revalidateVerifiedImportPreview(
    evidence.basePath,
    evidence.previewInput,
    evidence.preview,
  );
  requireApprovedRecoverPreview(finalPreview, approvedPreviewHash);
  const receipt = applyLegacyImport({
    invocation: {
      idempotencyKey: `legacy-import/recover/${finalPreview.preview.preview_id}`,
      sourceTransport: "internal",
      actorType: "system",
      actorId: "gsd-recover",
    },
    previewInput: evidence.previewInput,
    preview: finalPreview,
    backup: prepared.backup,
    ...(finalPreview.preview.counts.delete === 0
      ? {}
      : { destructiveConsent: createLegacyImportApplicationConsent(finalPreview) }),
  });
  const database = _getAdapter();
  if (!database) throw new Error("gsd recover lost its open project database");
  const result = {
    receipt,
    preview: finalPreview,
    backup: prepared.backup,
    counts: {
      milestones: countRecoverRows(database, "milestones"),
      slices: countRecoverRows(database, "slices"),
      tasks: countRecoverRows(database, "tasks"),
    },
  };
  persistRecoverApplication(result);
  return result;
}

export function applyVerifiedRecoverApplication(
  basePath: string,
  approvedPreviewHash: string,
): VerifiedRecoverApplicationResult {
  return applyPreparedVerifiedRecoverApplication(
    prepareVerifiedRecoverEvidence(basePath),
    approvedPreviewHash,
  );
}

interface RecoverApplicationManifestPayload {
  schemaVersion: 1;
  receipt: LegacyImportApplicationReceipt;
  preview: LegacyImportPreviewArtifact;
  backup: LegacyImportVerifiedBackup;
}

let recoverManifestSyncForTest: ((path: string) => void) | null = null;

export function _setRecoverManifestSyncForTest(hook: ((path: string) => void) | null): void {
  recoverManifestSyncForTest = hook;
}

function recoverApplicationManifestPath(operationId: string): string {
  if (!/^[0-9a-f-]{36}$/u.test(operationId)) throw new Error("retained Import Application operation ID is invalid");
  const databasePath = getWorkflowDatabasePath();
  if (!databasePath || databasePath === ":memory:") throw new Error("retained Import Application requires a file-backed database");
  return join(dirname(databasePath), "recovery-applications", `${operationId}.json`);
}

function recoverRestoreApprovalPath(operationId: string): string {
  return recoverApplicationManifestPath(operationId).replace(/\.json$/u, ".restore.json");
}

function syncRecoverManifest(path: string): void {
  const manifestDirectory = dirname(path);
  const databaseDirectory = dirname(manifestDirectory);
  recoverManifestSyncForTest?.(path);
  // Windows fsync (FlushFileBuffers) requires a handle with GENERIC_WRITE, so
  // the sync handle opens read-write there; POSIX keeps read-only.
  const descriptor = openSync(path, process.platform === "win32" ? "r+" : "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  recoverManifestSyncForTest?.(manifestDirectory);
  syncRecoverDirectory(manifestDirectory);
  recoverManifestSyncForTest?.(databaseDirectory);
  syncRecoverDirectory(databaseDirectory);
}

function syncRecoverDirectory(path: string): void {
  if (process.platform === "win32") {
    syncDirectoryEntry(path);
    return;
  }
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function persistRecoverApplication(application: VerifiedRecoverApplicationResult): void {
  const payload: RecoverApplicationManifestPayload = {
    schemaVersion: 1,
    receipt: application.receipt,
    preview: application.preview,
    backup: application.backup,
  };
  const path = recoverApplicationManifestPath(application.receipt.operationId);
  atomicWriteSync(path, JSON.stringify({
    payload,
    payloadHash: hashLegacyImportValue(payload as unknown as LegacyImportValue),
  }));
  syncRecoverManifest(path);
}

export function persistVerifiedRecoverRestoreApproval(
  application: Readonly<VerifiedRecoverApplicationResult>,
  assessment: Readonly<LegacyImportRestoreAssessment>,
  consent: Readonly<LegacyImportRestoreAssessmentConsent>,
): void {
  const payload = {
    schemaVersion: 1,
    applicationOperationId: application.receipt.operationId,
    applicationIdentityHash: application.receipt.applicationIdentityHash,
    assessment,
    consent,
  };
  const path = recoverRestoreApprovalPath(application.receipt.operationId);
  atomicWriteSync(path, JSON.stringify({
    payload,
    payloadHash: hashLegacyImportValue(payload as unknown as LegacyImportValue),
  }));
  syncRecoverManifest(path);
}

function loadRecoverRestoreApproval(
  operationId: string,
  applicationIdentityHash: string,
): VerifiedRecoverRestoreApproval | undefined {
  const path = recoverRestoreApprovalPath(operationId);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const payload = value["payload"] as Record<string, unknown> | undefined;
  if (Object.keys(value).sort().join("\0") !== "payload\0payloadHash"
    || typeof value["payloadHash"] !== "string"
    || payload === undefined
    || payload === null
    || Array.isArray(payload)
    || Object.keys(payload).sort().join("\0")
      !== "applicationIdentityHash\0applicationOperationId\0assessment\0consent\0schemaVersion"
    || payload["schemaVersion"] !== 1
    || payload["applicationOperationId"] !== operationId
    || payload["applicationIdentityHash"] !== applicationIdentityHash
    || value["payloadHash"] !== hashLegacyImportValue(payload as unknown as LegacyImportValue)) {
    throw new Error("retained restore approval is invalid");
  }
  return {
    assessment: payload["assessment"] as LegacyImportRestoreAssessment,
    consent: payload["consent"] as LegacyImportRestoreAssessmentConsent,
  };
}

function loadRecoverApplicationManifest(operationId: string): RecoverApplicationManifestPayload {
  const value = JSON.parse(readFileSync(recoverApplicationManifestPath(operationId), "utf8")) as Record<string, unknown>;
  if (Object.keys(value).sort().join("\0") !== "payload\0payloadHash"
    || typeof value["payloadHash"] !== "string"
    || value["payload"] === null
    || typeof value["payload"] !== "object"
    || Array.isArray(value["payload"])) {
    throw new Error("retained Import Application manifest is invalid");
  }
  const payload = value["payload"] as unknown as RecoverApplicationManifestPayload;
  if (value["payloadHash"] !== hashLegacyImportValue(payload as unknown as LegacyImportValue)
    || Object.keys(payload).sort().join("\0") !== "backup\0preview\0receipt\0schemaVersion"
    || payload.schemaVersion !== 1
    || payload.receipt.operationId !== operationId
    || !isValidLegacyImportVerifiedBackup(payload.backup)
    || payload.receipt.applicationIdentityHash.length === 0
    || payload.receipt.previewId !== payload.preview.preview.preview_id
    || payload.receipt.previewHash !== payload.preview.preview_hash
    || payload.receipt.backupId !== payload.backup.backup_id) {
    throw new Error("retained Import Application manifest is inconsistent");
  }
  return payload;
}

function verifiedRecoverResult(
  receipt: LegacyImportApplicationReceipt,
  preview: LegacyImportPreviewArtifact,
  backup: LegacyImportVerifiedBackup,
  capturedBase = inspectSqliteReadOnlySnapshot(backup.backup_ref, (database) => captureLegacyImportBaseSnapshot({
    readTransaction: (operation) => operation(),
    source: createLegacyImportBaseSnapshotSource(database),
  })),
): VerifiedRecoverApplicationResult {
  verifyLegacyImportBackupArtifact({ backup, preview, base: capturedBase });
  const database = _getAdapter();
  if (!database) throw new Error("gsd recover lost its open project database");
  return {
    receipt,
    preview,
    backup,
    counts: {
      milestones: countRecoverRows(database, "milestones"),
      slices: countRecoverRows(database, "slices"),
      tasks: countRecoverRows(database, "tasks"),
    },
    restoreApproval: loadRecoverRestoreApproval(receipt.operationId, receipt.applicationIdentityHash),
  };
}

export function loadVerifiedRecoverApplication(operationId: string): VerifiedRecoverApplicationResult {
  const database = _getAdapter();
  if (!database) throw new Error("gsd recover lost its open project database");
  const terminal = database.prepare(`SELECT application_identity_hash, preview_id, preview_hash, backup_id
    FROM workflow_import_restores WHERE application_operation_id = :operation_id`).get({ ":operation_id": operationId });
  if (terminal) {
    const retained = loadRecoverApplicationManifest(operationId);
    if (terminal["application_identity_hash"] !== retained.receipt.applicationIdentityHash
      || terminal["preview_id"] !== retained.preview.preview.preview_id
      || terminal["preview_hash"] !== retained.preview.preview_hash
      || terminal["backup_id"] !== retained.backup.backup_id
      || assessLegacyImportRestore({
        applicationIdentityHash: retained.receipt.applicationIdentityHash,
        backup: retained.backup,
      }).decision !== "already-restored") {
      throw new Error("retained Import Application does not match its durable restore receipt");
    }
    return verifiedRecoverResult({ ...retained.receipt, status: "replayed" }, retained.preview, retained.backup);
  }
  let application: ReturnType<typeof inspectLegacyImportApplicationEvidence>;
  try {
    application = inspectLegacyImportApplicationEvidence(operationId);
  } catch (error) {
    if (!(error instanceof LegacyImportApplicationEvidenceError)) throw error;
    if (retainedLegacyImportRestoreOperationId() !== operationId) throw error;
    const retained = loadRecoverApplicationManifest(operationId);
    const restoreApproval = loadRecoverRestoreApproval(
      operationId,
      retained.receipt.applicationIdentityHash,
    );
    if (restoreApproval === undefined) throw error;
    assertRetainedLegacyImportRestoreIntent(
      operationId,
      retained.receipt.applicationIdentityHash,
      retained.backup,
      restoreApproval,
    );
    return verifiedRecoverResult(
      { ...retained.receipt, status: "replayed" },
      retained.preview,
      retained.backup,
    );
  }
  const base = inspectSqliteReadOnlySnapshot(application.backupRef, (backupDatabase) => captureLegacyImportBaseSnapshot({
    readTransaction: (operation) => operation(),
    source: createLegacyImportBaseSnapshotSource(backupDatabase),
  }));
  const backup = sealLegacyImportVerifiedBackup({
    preview: application.preview,
    base,
    backup_ref: application.backupRef,
    backup_sha256: application.backupSha256,
    backup_byte_size: application.backupByteSize,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: application.backupVerifiedAt,
  });
  if (backup.backup_id !== application.backupId
    || hashLegacyImportValue(backup) !== application.backupArtifactHash) {
    throw new Error("retained Import Application backup identity is inconsistent");
  }
  const receipt: LegacyImportApplicationReceipt = {
      status: "replayed",
      operationId: application.operationId,
      projectId: application.projectId,
      applicationIdentityHash: application.applicationIdentityHash,
      previewId: application.preview.preview.preview_id,
      previewHash: application.preview.preview_hash,
      backupId: application.backupId,
      baseProjectRevision: application.baseProjectRevision,
      baseAuthorityEpoch: application.baseAuthorityEpoch,
      resultingRevision: application.resultingProjectRevision,
      resultingAuthorityEpoch: application.resultingAuthorityEpoch,
      appliedAt: application.createdAt,
      eventIds: [application.eventId],
      outboxIds: application.outboxIds,
      projectionWorkIds: application.projectionWorkIds,
  };
  const result = verifiedRecoverResult(receipt, application.preview, backup, base);
  persistRecoverApplication(result);
  return result;
}

function retainedRecoverApplicationId(): string | null {
  const database = _getAdapter();
  if (!database) throw new Error("gsd recover lost its open project database");
  const rows = database.prepare(`SELECT application.operation_id
    FROM workflow_import_applications application
    JOIN workflow_operations operation USING (operation_id)
    WHERE operation.actor_id = 'gsd-recover'
      AND operation.idempotency_key GLOB 'legacy-import/recover/*'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_import_forward_repairs repair
        WHERE repair.application_operation_id = application.operation_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_import_restores restore
        WHERE restore.application_operation_id = application.operation_id
      )
    ORDER BY operation.created_at, application.operation_id`).all();
  if (rows.length > 1) {
    throw new Error("multiple retained recover Applications require an explicit --application selection");
  }
  const operationId = rows[0]?.["operation_id"];
  return typeof operationId === "string" ? operationId : retainedLegacyImportRestoreOperationId();
}

export function loadRetainedVerifiedRecoverApplication(): VerifiedRecoverApplicationResult | null {
  const operationId = retainedRecoverApplicationId();
  return operationId === null ? null : loadVerifiedRecoverApplication(operationId);
}

export function applyOrResumeVerifiedRecoverApplication(
  basePath: string,
  approvedPreviewHash: string,
): VerifiedRecoverApplicationResult {
  return loadRetainedVerifiedRecoverApplication()
    ?? applyVerifiedRecoverApplication(basePath, approvedPreviewHash);
}

export function applyVerifiedMigrationApplication(
  basePath: string,
  sourcePaths: readonly string[],
  sourceGsdRoot: string = gsdRoot(basePath),
  beforeApply?: (evidence: { previewId: string; previewHash: string }) => void,
  artifactEvidence: readonly VerifiedMigrationArtifactEvidence[] = [],
): VerifiedMigrationCounts {
  const location = resolveWorkflowDatabaseLocation(basePath);
  if (sourcePaths.length === 0) throw new Error("gsd migrate requires generated source files");
  const generatedGsd = realpathSync(sourceGsdRoot);
  const stagingRoot = mkdtempSync(join(location.projectRoot, ".gsd-migration-import-"));
  try {
    const expectedArtifacts = [...artifactEvidence]
      .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
    const artifactPaths = new Set(expectedArtifacts.map((artifact) => artifact.logicalPath));
    const logicalPaths: string[] = [];
    for (const physicalPath of sourcePaths) {
      const realSource = realpathSync(physicalPath);
      const logicalPath = relative(generatedGsd, realSource).replaceAll("\\", "/");
      if (logicalPath.length === 0 || logicalPath === ".." || logicalPath.startsWith("../")) {
        throw new Error("gsd migrate source escaped the generated .gsd directory");
      }
      logicalPaths.push(logicalPath);
      if (artifactPaths.has(logicalPath)) continue;
      const stagedPath = join(stagingRoot, logicalPath);
      mkdirSync(dirname(stagedPath), { recursive: true });
      cpSync(realSource, stagedPath);
    }
    const artifacts = new Map<string, Record<string, string | null>>();
    const decisions = new Map<string, Record<string, string | number | null>>();
    const database = _getAdapter();
    if (!database) throw new Error("gsd migrate lost its open project database");
    for (const row of database.prepare(`SELECT seq, id, when_context, scope, decision, choice,
      rationale, revisable, made_by, source, superseded_by FROM decisions ORDER BY seq`).all()) {
      const id = String(row["id"]);
      decisions.set(id, {
        seq: Number(row["seq"]),
        id,
        when_context: String(row["when_context"] ?? ""),
        scope: String(row["scope"] ?? ""),
        decision: String(row["decision"] ?? ""),
        choice: String(row["choice"] ?? ""),
        rationale: String(row["rationale"] ?? ""),
        revisable: String(row["revisable"] ?? ""),
        made_by: String(row["made_by"] ?? "agent"),
        source: String(row["source"] ?? "migration"),
        superseded_by: row["superseded_by"] === null ? null : String(row["superseded_by"]),
      });
    }
    const decisionsPath = join(generatedGsd, "DECISIONS.md");
    let nextDecisionSequence = Math.max(0, ...[...decisions.values()].map((decision) => Number(decision["seq"]))) + 1;
    if (existsSync(decisionsPath)) {
      for (const decision of parseDecisionsTable(readFileSync(decisionsPath, "utf8"))) {
        const id = decision.id;
        const existing = decisions.get(id);
        decisions.set(id, {
          seq: Number(existing?.["seq"] ?? nextDecisionSequence++),
          ...decision,
          source: "migration",
        });
      }
    }
    for (const row of database.prepare(`SELECT path, artifact_type, milestone_id, slice_id, task_id,
      full_content, imported_at, content_hash FROM artifacts ORDER BY path`).all()) {
      const path = String(row["path"]);
      artifacts.set(path, {
        path,
        artifact_type: String(row["artifact_type"] ?? ""),
        milestone_id: row["milestone_id"] === null ? null : String(row["milestone_id"]),
        slice_id: row["slice_id"] === null ? null : String(row["slice_id"]),
        task_id: row["task_id"] === null ? null : String(row["task_id"]),
        full_content: String(row["full_content"] ?? ""),
        imported_at: String(row["imported_at"] ?? ""),
        content_hash: row["content_hash"] === null ? null : String(row["content_hash"]),
      });
    }
    for (const artifact of expectedArtifacts) {
      const source = realpathSync(join(generatedGsd, artifact.logicalPath));
      const logicalPath = relative(generatedGsd, source).replaceAll("\\", "/");
      if (logicalPath !== artifact.logicalPath || logicalPath === ".." || logicalPath.startsWith("../")) {
        throw new Error("gsd migrate artifact escaped the retained projection");
      }
      const content = readFileSync(source, "utf8");
      const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (sha256 !== artifact.sha256) {
        throw new Error(`gsd migrate retained artifact changed at ${artifact.logicalPath}`);
      }
      const path = `.gsd/${artifact.logicalPath}`;
      artifacts.set(path, {
        path,
        artifact_type: artifact.logicalPath.match(/(?:^|[-/])([A-Z]+)\.md$/u)?.[1] ?? "migration-artifact",
        milestone_id: artifact.logicalPath.match(/(?:^|\/)milestones\/(M\d+)(?:\/|$)/u)?.[1] ?? null,
        slice_id: artifact.logicalPath.match(/(?:^|\/)slices\/(S\d+)(?:\/|$)/u)?.[1] ?? null,
        task_id: artifact.logicalPath.match(/(?:^|\/)tasks\/(T\d+)(?:-|\/|$)/u)?.[1] ?? null,
        full_content: content,
        imported_at: "",
        content_hash: sha256.slice("sha256:".length),
      });
    }
    if (expectedArtifacts.length > 0) {
      const manifestPath = join(stagingRoot, "state-manifest.json");
      writeFileSync(manifestPath, `${JSON.stringify({
        version: 1,
        exported_at: "1970-01-01T00:00:00.000Z",
        milestones: [],
        slices: [],
        tasks: [],
        decisions: [...decisions.values()],
        verification_evidence: [],
        artifacts: [...artifacts.values()],
      })}\n`);
    }
    const previewInput: LegacyImportPreviewCreateInput = {
      roots: [{
        id: "migration-source",
        kind: "project",
        physical_path: stagingRoot,
        logical_path: ".gsd",
        presence: "required",
      }],
    };
    const created = prepareVerifiedImportPreview(basePath, previewInput);
    const preservable = new Set(created.preview.preview.diagnoses
      .filter((diagnosis) => diagnosis.code === "ambiguous-task-membership")
      .map((diagnosis) => diagnosis.diagnosis_id));
    const resolved = resolveLegacyImportPreview(
      created.preview,
      created.preview.preview.resolutions.flatMap((resolution) => (
        resolution.disposition === "requires-user" && preservable.has(resolution.diagnosis_id)
          ? [{ diagnosis_id: resolution.diagnosis_id, disposition: "preserved" as const }]
          : []
      )),
    );
    const evidence = prepareVerifiedImportEvidence(
      { ...created, preview: resolved },
      "pre-migrate-import",
    );
    beforeApply?.({
      previewId: evidence.preview.preview.preview_id,
      previewHash: evidence.preview.preview_hash,
    });
    const receipt = applyLegacyImport({
      invocation: {
        idempotencyKey: `legacy-import/migrate/${evidence.preview.preview.preview_id}`,
        sourceTransport: "internal",
        actorType: "system",
        actorId: "gsd-migrate",
      },
      previewInput: evidence.previewInput,
      preview: evidence.preview,
      backup: evidence.backup,
    });
    const application = inspectLegacyImportApplicationEvidence(receipt.operationId);
    return verifiedMigrationCounts(application, logicalPaths, expectedArtifacts);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function verifiedMigrationCounts(
  application: ReturnType<typeof inspectLegacyImportApplicationEvidence>,
  logicalPaths: readonly string[],
  artifactEvidence: readonly VerifiedMigrationArtifactEvidence[] = [],
): VerifiedMigrationCounts {
  const reviewedPaths = new Set(logicalPaths);
  const artifactPaths = new Set(artifactEvidence.map((artifact) => artifact.logicalPath));
  const importedSourcePaths = new Set([...reviewedPaths].filter((path) => !artifactPaths.has(path)));
  const reviewedSources = application.preview.preview.sources;
  const manifestSources = reviewedSources.filter((source) => source.path === ".gsd/state-manifest.json");
  const projectionTargets = [
    ...reviewedSources
    .filter((source) => source.path !== ".gsd/state-manifest.json")
    .map((source) => ({
      sourceId: source.source_id,
      logicalPath: source.path.replace(/^\.gsd\//u, ""),
      sha256: source.sha256,
    })),
    ...artifactEvidence.map(({ logicalPath, sha256 }) => ({
      sourceId: `migration-artifact:${logicalPath}`,
      logicalPath,
      sha256,
    })),
  ].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  if (reviewedSources.length - manifestSources.length !== importedSourcePaths.size
    || reviewedSources.some((source) => (
      source.path !== ".gsd/state-manifest.json"
      && !importedSourcePaths.has(source.path.replace(/^\.gsd\//u, ""))
    ))
    || manifestSources.length !== (artifactEvidence.length > 0 ? 1 : 0)) {
    throw new Error("gsd migrate retained Application source set did not match generated files");
  }
  const expectedArtifactKeys = new Set(artifactEvidence.map((artifact) => `.gsd/${artifact.logicalPath}`));
  const targets = application.plan.instructions
    .filter((instruction) => instruction.targetKind !== "artifact" || expectedArtifactKeys.has(instruction.targetKey))
    .map((instruction) => ({
    targetKind: instruction.targetKind,
    targetKey: instruction.targetKey,
    contentHash: hashLegacyImportValue(instruction as unknown as LegacyImportValue),
  }));
  const countTargets = (targetKind: string): number => application.plan.affectedTargets
    .filter((target) => target.targetKind === targetKind).length;
  for (const artifact of artifactEvidence) {
    const targetKey = `.gsd/${artifact.logicalPath}`;
    const instruction = application.plan.instructions.find((candidate) => (
      candidate.targetKind === "artifact" && candidate.targetKey === targetKey
    ));
    const values = instruction !== undefined && "values" in instruction ? instruction.values : undefined;
    const fullContent = values?.["full_content"];
    const contentHash = values?.["content_hash"];
    if (typeof fullContent !== "string"
      || `sha256:${createHash("sha256").update(fullContent).digest("hex")}` !== artifact.sha256
      || contentHash !== artifact.sha256.slice("sha256:".length)) {
      throw new Error(`gsd migrate retained Application omitted exact artifact ${artifact.logicalPath}`);
    }
  }
  return {
    decisions: countTargets("decision"),
    requirements: countTargets("requirement"),
    artifacts: artifactEvidence.length,
    hierarchy: {
      milestones: countTargets("milestone"),
      slices: countTargets("slice"),
      tasks: countTargets("task"),
    },
    targets,
    application: {
      operationId: application.operationId,
      previewId: application.preview.preview.preview_id,
      resultingRevision: application.resultingProjectRevision,
      resultingAuthorityEpoch: application.resultingAuthorityEpoch,
      previewHash: application.preview.preview_hash,
      sourceSetHash: application.preview.preview.source_set_hash,
      changeSetHash: application.preview.preview.change_set_hash,
      applicationRelevantRowsHash: application.applicationRelevantRowsHash,
      projectionTargets,
      targets,
    },
  };
}

export function loadVerifiedMigrationApplication(
  operationId: string,
  logicalPaths: readonly string[],
  artifactEvidence: readonly VerifiedMigrationArtifactEvidence[] = [],
): VerifiedMigrationCounts {
  return verifiedMigrationCounts(inspectLegacyImportApplicationEvidence(operationId), logicalPaths, artifactEvidence);
}

export function loadVerifiedMigrationApplicationByPreviewId(
  previewId: string,
  logicalPaths: readonly string[],
  artifactEvidence: readonly VerifiedMigrationArtifactEvidence[] = [],
): VerifiedMigrationCounts | null {
  const database = _getAdapter();
  if (!database) throw new Error("gsd migrate lost its open project database");
  const rows = database.prepare(`SELECT application.operation_id
    FROM workflow_import_applications application
    JOIN workflow_operations operation USING (operation_id)
    WHERE application.preview_id = :preview_id
      AND operation.actor_id = 'gsd-migrate'
      AND operation.idempotency_key GLOB 'legacy-import/migrate/*'
    ORDER BY application.operation_id`).all({ ":preview_id": previewId });
  if (rows.length > 1) throw new Error("migration Preview matched multiple retained Import Applications");
  const operationId = rows[0]?.["operation_id"];
  return typeof operationId === "string"
    ? loadVerifiedMigrationApplication(operationId, logicalPaths, artifactEvidence)
    : null;
}
