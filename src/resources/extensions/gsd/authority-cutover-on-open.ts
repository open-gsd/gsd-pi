// Project/App: gsd-pi
// File Purpose: Automatic lifecycle backfill and Authority Epoch cutover on the first open of a pre-cutover project database.

import { copyFileSync, existsSync } from "node:fs";

import { listUncoveredHierarchyRows } from "./db-lifecycle-coverage-schema.js";
import { backupDatabaseBeforeMigration } from "./db-migration-backup.js";
import { getDb, getDbPath, SCHEMA_VERSION } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { withFileLockSync } from "./file-lock.js";
import { applyLifecycleBackfill, previewLifecycleBackfill } from "./lifecycle-backfill-domain-operation.js";
import {
  cutoverProjectAuthority,
  inspectProjectAuthorityCutoverEvidence,
  PROJECT_AUTHORITY_CONTRACT_VERSION,
  PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
  ProjectAuthorityCutoverError,
  requireCoordinationIdle,
} from "./project-authority-cutover-domain-operation.js";
import { logError, logWarning } from "./workflow-logger.js";

/** True while the operation head is an Import Application: its Restore Window is still open. */
export function importRestoreWindowIsOpen(fence: { projectId: string; revision: number }): boolean {
  const head = getDb().prepare(`
    SELECT operation_type FROM workflow_operations
    WHERE project_id = :project_id AND resulting_revision = :revision
  `).get({ ":project_id": fence.projectId, ":revision": fence.revision });
  return head?.["operation_type"] === "import.apply";
}

function backfillAndCutOver(basePath: string): void {
  const fence = readDomainOperationFence();
  // Another process cut the project over before this one took the lock.
  if (fence.authorityEpoch > 0) return;
  // The backfill and the cutover would both close the Restore Window. The
  // next accepted work closes it, and the open after that cuts over.
  if (importRestoreWindowIsOpen(fence)) return;
  const preview = previewLifecycleBackfill();
  if (preview.unknownStatuses.length > 0) {
    logError(
      "db",
      `Authority cutover stopped: ${preview.unknownStatuses.length} row(s) have a legacy status with no lifecycle mapping. ` +
        "Nothing was changed. Fix each status, then reopen the project:\n" +
        preview.unknownStatuses.map((entry) => `  ${entry.row}: ${JSON.stringify(entry.rawStatus)}`).join("\n"),
    );
    return;
  }
  // The automatic run never changes a legacy status.
  const statusChanges = preview.items.filter((item) => item.projectedLegacyStatus !== null);
  if (statusChanges.length > 0) {
    logError(
      "db",
      `Authority cutover stopped: the lifecycle backfill would change the status of ${statusChanges.length} row(s). ` +
        "Nothing was changed. Run /gsd db adopt to preview the backfill, then /gsd db adopt --apply, then reopen the project:\n" +
        statusChanges.map((item) =>
          `  ${item.itemKind} ${[item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/")}: ` +
          `${JSON.stringify(item.rawStatus)} -> ${JSON.stringify(item.projectedLegacyStatus)} (${item.rule})`
        ).join("\n"),
    );
    return;
  }
  requireCoordinationIdle();
  backupDatabaseBeforeMigration(getDb(), getDbPath(), SCHEMA_VERSION, { existsSync, copyFileSync, logWarning });
  if (
    preview.items.length > 0 || preview.waiverRepairs.length > 0 ||
    preview.unmarkedImportCompletions.length > 0
  ) {
    const { findings } = applyLifecycleBackfill(basePath);
    if (findings.length > 0) {
      logWarning("db", `Lifecycle backfill adopted ${findings.length} row(s) with a finding:\n  ${findings.join("\n  ")}`);
    }
  }
  const evidence = inspectProjectAuthorityCutoverEvidence();
  cutoverProjectAuthority({
    invocation: {
      idempotencyKey: `open/authority-cutover/${fence.authorityEpoch}`,
      sourceTransport: "internal",
      actorType: "system",
    },
    expectedRevision: evidence.projectRevision,
    // The epoch that was checked, not the one read now: the epoch advances
    // once whatever a concurrent process does.
    expectedAuthorityEpoch: fence.authorityEpoch,
    authorityContractVersion: PROJECT_AUTHORITY_CONTRACT_VERSION,
    evidenceHash: evidence.evidenceHash,
    consent: {
      consentSchemaVersion: PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      irreversibleAuthorityCutover: true,
      evidenceHash: evidence.evidenceHash,
    },
  });
}

/**
 * A project that an earlier build cut over can hold a hierarchy row with no
 * lifecycle row. The coverage fence then refuses every Domain Operation, so
 * the open adopts those rows first, with the rules of the backfill and a
 * verified backup, and logs each legacy status it changed. A row with an
 * unknown raw status stops the run: the fence stays, and the error names it.
 */
function adoptRowsLeftAfterCutover(basePath: string): void {
  if (listUncoveredHierarchyRows(getDb()).length === 0) return;
  const preview = previewLifecycleBackfill();
  if (preview.unknownStatuses.length > 0) {
    logError(
      "db",
      `Lifecycle backfill stopped: ${preview.unknownStatuses.length} row(s) have a legacy status with no lifecycle mapping. ` +
        "Nothing was changed, and the project refuses every write until each row has a lifecycle row. " +
        "Fix each status, then run /gsd db adopt --apply:\n" +
        preview.unknownStatuses.map((entry) => `  ${entry.row}: ${JSON.stringify(entry.rawStatus)}`).join("\n"),
    );
    return;
  }
  backupDatabaseBeforeMigration(getDb(), getDbPath(), SCHEMA_VERSION, { existsSync, copyFileSync, logWarning });
  const { adopted, findings } = applyLifecycleBackfill(basePath);
  const statusChanges = preview.items.filter((item) => item.projectedLegacyStatus !== null).map((item) =>
    `${item.itemKind} ${[item.milestoneId, item.sliceId, item.taskId].filter(Boolean).join("/")}: ` +
    `${JSON.stringify(item.rawStatus)} -> ${JSON.stringify(item.projectedLegacyStatus)} (${item.rule})`
  );
  logWarning(
    "db",
    `Lifecycle backfill adopted ${adopted} row(s) that had no lifecycle row after the Authority Epoch cutover. ` +
      "A verified backup was written beside the database." +
      (statusChanges.length > 0 ? `\nLegacy status changed:\n  ${statusChanges.join("\n  ")}` : "") +
      (findings.length > 0 ? `\nFindings:\n  ${findings.join("\n  ")}` : ""),
  );
}

function authorityEpochAdvanced(): boolean {
  try {
    return readDomainOperationFence().authorityEpoch > 0;
  } catch {
    // The failure that is being reported stands.
    return false;
  }
}

/**
 * Owner decision 2026-10-04: a project database whose Authority Epoch is
 * still 0 is backed up, backfilled (lifecycle.backfill) and cut over
 * (authority.cutover) when it opens. The user does nothing, so the decision
 * is the standing Consent for the one-way cutover.
 *
 * This is the default. GSD_AUTHORITY_CUTOVER=0 turns it off; the opt-out is
 * kept for one release.
 *
 * The run stops before the backup, with nothing changed, the rows logged as
 * an error and a doctor issue, when a row has a legacy status with no
 * lifecycle mapping, or when the backfill would change a legacy status: reopen
 * a legacy completion that has no evidence, or cancel open work under a
 * completed or cancelled parent. Those status changes need the preview of
 * `/gsd db adopt`.
 *
 * Active coordination and an open Import Application Restore Window defer
 * the run to a later open. A file lock beside the database lets one process
 * run it at a time: without it, a process that opens the project during the
 * run fails on the busy database and logs a false error. That process leaves
 * the run to the lock holder. No failure here fails the open.
 *
 * The opt-out does not apply to a database that is already cut over: the open
 * adopts every hierarchy row that has no lifecycle row (adoptRowsLeftAfterCutover).
 */
export function cutOverProjectAuthorityOnOpen(basePath: string): void {
  let cutOver = false;
  try {
    cutOver = readDomainOperationFence().authorityEpoch > 0;
    if (!cutOver && process.env.GSD_AUTHORITY_CUTOVER === "0") return;
    const databasePath = getDbPath();
    if (databasePath === null) return;
    if (cutOver && listUncoveredHierarchyRows(getDb()).length === 0) return;
    withFileLockSync(
      databasePath,
      () => cutOver ? adoptRowsLeftAfterCutover(basePath) : backfillAndCutOver(basePath),
      { retries: 0 },
    );
  } catch (error) {
    // Another process holds the lock, or finished the cutover while this one failed.
    if ((error as { code?: unknown } | null)?.code === "ELOCKED" || (!cutOver && authorityEpochAdvanced())) return;
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    const message = (error instanceof Error ? error.message : String(error)) + cause;
    if (cutOver) {
      logError("db", `Lifecycle backfill of the rows left without a lifecycle row failed: ${message}`);
      return;
    }
    if (error instanceof ProjectAuthorityCutoverError && error.retryable) {
      logWarning("db", `Authority cutover deferred to a later open: ${message}`);
      return;
    }
    logError("db", `Automatic lifecycle backfill and authority cutover failed; the Authority Epoch did not advance: ${message}`);
  }
}
