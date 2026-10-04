// Project/App: gsd-pi
// File Purpose: Automatic lifecycle backfill and Authority Epoch cutover on the first open of a pre-cutover project database.

import { copyFileSync, existsSync } from "node:fs";

import { backupDatabaseBeforeMigration } from "./db-migration-backup.js";
import { getDb, getDbPath, SCHEMA_VERSION } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
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

/**
 * Owner decision 2026-10-04: a project database whose Authority Epoch is
 * still 0 is backed up, backfilled (lifecycle.backfill) and cut over
 * (authority.cutover) when it opens. The user does nothing, so the decision
 * is the standing Consent for the one-way cutover.
 *
 * A row whose legacy status has no lifecycle mapping stops the run before the
 * backup: nothing changes, the rows are logged as an error, and doctor lists
 * them. Active coordination defers the run to a later open. No failure here
 * fails the open.
 */
export function cutOverProjectAuthorityOnOpen(basePath: string): void {
  try {
    if (readDomainOperationFence().authorityEpoch > 0) return;
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
    requireCoordinationIdle();
    backupDatabaseBeforeMigration(getDb(), getDbPath(), SCHEMA_VERSION, { existsSync, copyFileSync, logWarning });
    if (preview.items.length > 0 || preview.waiverRepairs.length > 0) {
      const result = applyLifecycleBackfill(basePath);
      // These rows were not adopted with the status the legacy row showed.
      const reported = [...result.findings, ...result.cancelledUnderCompletedParent];
      if (reported.length > 0) {
        logWarning("db", `Lifecycle backfill adopted ${reported.length} row(s) with a changed status:\n  ${reported.join("\n  ")}`);
      }
    }
    const evidence = inspectProjectAuthorityCutoverEvidence();
    cutoverProjectAuthority({
      invocation: {
        idempotencyKey: `open/authority-cutover/${evidence.authorityEpoch}`,
        sourceTransport: "internal",
        actorType: "system",
      },
      expectedRevision: evidence.projectRevision,
      expectedAuthorityEpoch: evidence.authorityEpoch,
      authorityContractVersion: PROJECT_AUTHORITY_CONTRACT_VERSION,
      evidenceHash: evidence.evidenceHash,
      consent: {
        consentSchemaVersion: PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
        decision: "proceed",
        irreversibleAuthorityCutover: true,
        evidenceHash: evidence.evidenceHash,
      },
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    const message = (error instanceof Error ? error.message : String(error)) + cause;
    if (error instanceof ProjectAuthorityCutoverError && error.retryable) {
      logWarning("db", `Authority cutover deferred to a later open: ${message}`);
      return;
    }
    logError("db", `Automatic lifecycle backfill and authority cutover failed; the Authority Epoch did not advance: ${message}`);
  }
}
