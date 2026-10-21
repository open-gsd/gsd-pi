// gsd-pi - /gsd migrate execution service.
// File Purpose: Write migrated .gsd files, import them into the DB, verify projection/readiness, and rollback on failure.

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import {
  applyVerifiedMigrationApplication,
  loadVerifiedRecoverApplication,
  loadVerifiedMigrationApplication,
  loadVerifiedMigrationApplicationByPreviewId,
} from "../db-workspace.js";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withDatabaseMaintenanceOwner } from "../database-maintenance-fence.js";
import { immediateTransaction, withDatabaseMaintenanceClaim } from "../db/engine.js";
import { inspectLegacyImportApplicationEvidence } from "../legacy-import-application-evidence.js";
import {
  verifyLegacyImportApplicationResult,
  verifyLegacyImportApplicationTargets,
} from "../legacy-import-application-result.js";
import { executeLegacyImportRecoveryAction } from "../legacy-import-recovery-action.js";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.js";
import { gsdRoot, MIGRATION_STAGING_DIR_PREFIX } from "../paths.js";
import { loadManagedProjectionPaths } from "../managed-projection-history.js";
import { deriveState, invalidateStateCache } from "../state.js";
import {
  archiveLegacyPlanningDirectory,
  canonicalForwardMigrationProjection,
  canonicalMigrationArtifactProjection,
  inspectCommittedMigrationAudit,
  managedStructuredProjectionPaths,
  recordMigrationAuditArtifacts,
  verifyAppliedMigrationProjection,
  verifyForwardRepairedMigrationProjection,
  verifyRetainedMigrationProjection,
  writeMigrationAudit,
  type LegacyArchiveResult,
  type MigrationAuditResult,
  type MigrationProjectionVerification,
} from "./audit.js";
import {
  assertMigrationProjectionRootIdentity,
  findMigrationPublication,
  findPendingMigrationPublication,
  materializeMigrationPublicationEvidence,
  migrationPublicationRequestHash,
  prepareMigrationPublication,
  proveMigrationProjectionRoot,
  pruneMigrationPublications,
  writeMigrationProjectionFile,
  removeMigrationProjectionPath,
  syncMigrationPublicationDirectories,
  syncMigrationPublicationOutputs,
  syncPublishedMigrationFiles,
  updateMigrationPublication,
  type MigrationPublicationRecord,
} from "./publication-store.js";
import {
  prepareMigrationTarget,
  type MigrationBackup,
} from "./safety.js";
import { writeGSDDirectory, type MigrationPreview, type WrittenFiles } from "./writer.js";
import type { GSDProject } from "./types.js";
import type { LegacyImportForwardRepairChoice } from "../legacy-import-forward-repair-plan.js";

export type MigrationImportCounts = ReturnType<typeof applyVerifiedMigrationApplication>;

export interface MigrationExecutionResult {
  backup: MigrationBackup;
  written: WrittenFiles;
  imported: MigrationImportCounts;
  legacyArchive: LegacyArchiveResult;
  verification: MigrationProjectionVerification;
  audit: MigrationAuditResult;
}

export function migrationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Migration failed without replacing database authority; any committed Import Application was retained: ${message}`;
}

function assertMigrationImportMatchesPreview(imported: MigrationImportCounts, preview: MigrationPreview): void {
  const mismatches: string[] = [];
  if (imported.decisions !== preview.decisions.total) {
    mismatches.push(`decisions ${imported.decisions}/${preview.decisions.total}`);
  }
  if (imported.hierarchy.milestones !== preview.milestoneCount) {
    mismatches.push(`milestones ${imported.hierarchy.milestones}/${preview.milestoneCount}`);
  }
  if (imported.hierarchy.slices !== preview.totalSlices) {
    mismatches.push(`slices ${imported.hierarchy.slices}/${preview.totalSlices}`);
  }
  if (imported.hierarchy.tasks !== preview.totalTasks) {
    mismatches.push(`tasks ${imported.hierarchy.tasks}/${preview.totalTasks}`);
  }
  if (imported.requirements !== preview.requirements.total) {
    mismatches.push(`requirements ${imported.requirements}/${preview.requirements.total}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`migration DB import verification failed: ${mismatches.join(", ")}`);
  }
}

function expectedMigrationTargets(project: GSDProject): string[] {
  const hierarchy = project.milestones.flatMap((milestone) => [
    `milestone\0${milestone.id}`,
    ...milestone.slices.flatMap((slice) => [
      `slice\0${milestone.id}/${slice.id}`,
      ...slice.tasks.map((task) => `task\0${milestone.id}/${slice.id}/${task.id}`),
    ]),
  ]);
  const decisions = [...project.decisionsContent.matchAll(/^\|\s*(D\d+)\s*\|/gmu)]
    .map((match) => `decision\0${match[1]}`);
  return [
    ...hierarchy,
    ...project.requirements.map((requirement) => `requirement\0${requirement.id}`),
    ...decisions,
  ].sort();
}

function assertMigrationExpectedTargets(
  imported: MigrationImportCounts,
  expected: readonly string[],
): void {
  const affected = new Set(imported.targets.map((target) => `${target.targetKind}\0${target.targetKey}`));
  const missing = expected.filter((target) => !affected.has(target));
  if (missing.length > 0) {
    throw new Error(`migration DB import verification failed: missing targets ${missing.join(", ")}`);
  }
}

function assertMigrationArtifactTargets(
  application: ReturnType<typeof inspectLegacyImportApplicationEvidence>,
  record: MigrationPublicationRecord,
): void {
  const expected = record.artifactHashes
    .map((target) => ({ key: target.logicalPath, hash: target.sha256 }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const reviewedSources = application.plan.instructions
    .flatMap((instruction) => instruction.targetKind === "artifact" && "values" in instruction
      ? [{
          key: instruction.targetKey.replace(/^\.gsd[\\/]/u, ""),
          hash: `sha256:${String(instruction.values?.["content_hash"] ?? "")}`,
        }]
      : [])
    .filter((target) => expected.some((candidate) => candidate.key === target.key))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  if (JSON.stringify(reviewedSources) !== JSON.stringify(expected)) {
    throw new Error(
      "migration DB import verification failed: staged artifact sources did not match; "
      + `sources=${JSON.stringify(reviewedSources)} expected=${JSON.stringify(expected)}`,
    );
  }
}

function publishRetainedProjection(
  record: MigrationPublicationRecord,
  sourcePaths: readonly string[],
  publishCanonicalArtifacts: boolean,
): void {
  for (let index = 0; index < sourcePaths.length; index++) {
    writeMigrationProjectionFile(record, record.logicalPaths[index]!, readFileSync(sourcePaths[index]!, "utf8"));
  }
  syncPublishedMigrationFiles(record);
  if (publishCanonicalArtifacts) publishCanonicalArtifactsFromDb(record);
}

function publishCanonicalArtifactsFromDb(record: MigrationPublicationRecord): string[] {
  canonicalForwardMigrationProjection();
  const paths = canonicalMigrationArtifactProjection().map((target) => {
    return writeMigrationProjectionFile(record, target.logicalPath, target.content);
  });
  syncMigrationPublicationOutputs(record, paths);
  return paths;
}

function publishCanonicalProjection(
  record: MigrationPublicationRecord,
  imported: MigrationImportCounts,
): void {
  const targets = canonicalForwardMigrationProjection();
  const expected = new Set(targets.map((target) => target.logicalPath));
  const provenManaged = new Set([
    ...record.managedProjectionPaths,
    ...loadManagedProjectionPaths(record.targetRoot),
  ]);
  const removedDirectories = new Set<string>();
  for (const target of imported.targets) {
    if (target.targetKind !== "artifact") continue;
    const logicalPath = target.targetKey.replace(/^\.gsd[\\/]/u, "").replaceAll("\\", "/");
    if (logicalPath.length > 0) provenManaged.add(logicalPath);
  }
  for (const logicalPath of managedStructuredProjectionPaths(record.targetRoot)) {
    if (expected.has(logicalPath)) continue;
    if (!provenManaged.has(logicalPath)) {
      throw new Error(`unexpected managed projection ${logicalPath}`);
    }
    const removedDirectory = removeMigrationProjectionPath(record, logicalPath);
    if (removedDirectory !== null) removedDirectories.add(removedDirectory);
  }
  for (const logicalPath of provenManaged) {
    if (expected.has(logicalPath)) continue;
    const removedDirectory = removeMigrationProjectionPath(record, logicalPath);
    if (removedDirectory !== null) removedDirectories.add(removedDirectory);
  }
  const paths = targets.map((target) => {
    return writeMigrationProjectionFile(record, target.logicalPath, target.content);
  });
  syncMigrationPublicationDirectories(record, [...removedDirectories]);
  if (paths.length > 0) syncMigrationPublicationOutputs(record, paths);
}

function runForwardRepair(
  imported: MigrationImportCounts,
  choices: readonly Readonly<LegacyImportForwardRepairChoice>[],
  sourcePath: string,
): string {
  const application = loadVerifiedRecoverApplication(imported.application.operationId);
  // Migration publication retains the Application's imported rows: the repair
  // only forwards the receipt to the current authority head. Reverting intact
  // Application changes ("revert" goal) would destroy the migration target.
  const action = executeLegacyImportRecoveryAction(application, "forward-repair", choices, undefined, "retain");
  if (action.status === "choice-required") {
    const details = action.choices.map((choice) => [
      `${choice.targetKind}/${choice.targetKey} (${choice.reasonCode})`,
      `current=${choice.currentValueJson}`,
      `proposed=${choice.proposedMutationJson}`,
      `recommended=${choice.recommendedDecision}: ${choice.recommendationRationale}`,
      "alternatives=preserve-later|restore-backup",
      `preserve: ${forwardChoiceFlag(choice, "preserve-later")}`,
      `restore: ${forwardChoiceFlag(choice, "restore-backup")}`,
    ].join("; ")).join("\n");
    const recommended = action.choices
      .map((choice) => forwardChoiceFlag(choice, choice.recommendedDecision))
      .join(" ");
    throw new Error(
      `migration Forward Repair for Application ${imported.application.operationId} requires explicit reviewed choice:\n${details}\n`
      + `Recommended resume: /gsd migrate ${recommended} ${JSON.stringify(sourcePath)}\n`
      + "To select an alternative, replace that target's flag with its displayed preserve or restore flag.",
    );
  }
  if (action.status !== "forward-repaired") {
    throw new Error("migration Forward Repair did not produce a terminal receipt");
  }
  return action.result.operationId;
}

function forwardChoiceFlag(
  choice: Pick<LegacyImportForwardRepairChoice, "instructionIndex" | "targetKind" | "targetKey" | "reviewHash">,
  decision: LegacyImportForwardRepairChoice["decision"],
): string {
  const evidence = {
    instructionIndex: choice.instructionIndex,
    targetKind: choice.targetKind,
    targetKey: choice.targetKey,
    reviewHash: choice.reviewHash,
  };
  return `--forward-choice=${Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url")}.${decision}`;
}

function sameAuthority(
  left: { revision: number; authority_epoch: number },
  revision: number | null,
  authorityEpoch: number | null,
): boolean {
  return revision !== null
    && authorityEpoch !== null
    && left.revision === revision
    && left.authority_epoch === authorityEpoch;
}

export async function importWrittenMigrationToDb(
  basePath: string,
  sourcePaths: readonly string[],
  preview?: MigrationPreview,
  sourceGsdRoot: string = gsdRoot(basePath),
  beforeApply?: (evidence: { previewId: string; previewHash: string }) => void,
  artifactEvidence: readonly { logicalPath: string; sha256: string }[] = [],
): Promise<MigrationImportCounts> {
  const opened = await ensureDbOpen(basePath);
  if (!opened) {
    throw new Error(`failed to open or create the GSD database at ${basePath}`);
  }

  const counts = applyVerifiedMigrationApplication(
    basePath,
    sourcePaths,
    sourceGsdRoot,
    beforeApply,
    artifactEvidence,
  );
  if (preview) assertMigrationImportMatchesPreview(counts, preview);
  invalidateStateCache();
  return counts;
}

function publicationWritten(record: MigrationPublicationRecord): WrittenFiles {
  const targetGsd = gsdRoot(record.targetRoot);
  return {
    counts: record.writtenCounts,
    paths: record.logicalPaths.map((logicalPath) => join(targetGsd, logicalPath)),
    artifactPaths: record.artifactHashes.map((target) => join(targetGsd, target.logicalPath)),
  };
}

async function completeMigrationPublication(
  initial: MigrationPublicationRecord,
  choices: readonly Readonly<LegacyImportForwardRepairChoice>[],
  evidence: { projectionRoot: string; legacyPath: string },
  claimed = false,
): Promise<MigrationExecutionResult> {
  let record = initial;
  assertMigrationProjectionRootIdentity(record);
  const sourceRoot = evidence.projectionRoot;
  const sourcePaths = record.logicalPaths.map((logicalPath) => join(sourceRoot, logicalPath));
  if (!claimed) {
    const opened = await ensureDbOpen(record.targetRoot);
    if (!opened) throw new Error(`failed to open or create the GSD database at ${record.targetRoot}`);
    return withDatabaseMaintenanceClaim(() => completeMigrationPublication(initial, choices, evidence, true));
  }

  let imported = record.applicationOperationId
    ? loadVerifiedMigrationApplication(record.applicationOperationId, record.logicalPaths, record.artifactHashes)
    : record.legacyPreviewId
      ? loadVerifiedMigrationApplicationByPreviewId(record.legacyPreviewId, record.logicalPaths, record.artifactHashes)
      : null;
  if (imported === null) {
    imported = await importWrittenMigrationToDb(
      record.targetRoot,
      sourcePaths,
      record.preview,
      sourceRoot,
      (evidence) => {
        withDatabaseMaintenanceOwner(join(gsdRoot(record.targetRoot), "gsd.db"), () => {
          record = updateMigrationPublication(record, {
            legacyPreviewId: evidence.previewId,
            legacyPreviewHash: evidence.previewHash,
          });
        });
      },
      record.artifactHashes,
    );
  }
  if (record.legacyPreviewId !== null
    && (record.legacyPreviewId !== imported.application.previewId
      || record.legacyPreviewHash !== imported.application.previewHash)) {
    throw new Error("migration publication did not match its retained Import Application");
  }
  assertMigrationImportMatchesPreview(imported, record.preview);
  assertMigrationExpectedTargets(imported, record.expectedTargets);
  if (record.phase === "prepared") {
    record = updateMigrationPublication(record, {
      phase: "applied",
      applicationOperationId: imported.application.operationId,
      imported,
    });
  }

  const written = publicationWritten(record);
  const application = inspectLegacyImportApplicationEvidence(imported.application.operationId);
  assertMigrationArtifactTargets(application, record);
  const current = captureCurrentLegacyImportBaseSnapshot();
  const retainedAudit = record.projectionRevision !== null && record.projectionAuthorityEpoch !== null
    ? inspectCommittedMigrationAudit(
      record.targetRoot,
      record.publicationKey,
      record.forwardRepairOperationId ?? imported.application.operationId,
      record.projectionRevision,
      record.projectionAuthorityEpoch,
    )
    : null;
  const baselineCompletionRevision = retainedAudit?.resultingRevision ?? record.completionRevision;
  const baselineCompletionEpoch = retainedAudit?.resultingAuthorityEpoch ?? record.completionAuthorityEpoch;
  const completedBaseline = sameAuthority(current.authority, baselineCompletionRevision, baselineCompletionEpoch);
  const applicationBaseline = sameAuthority(
    current.authority,
    application.resultingProjectRevision,
    application.resultingAuthorityEpoch,
  );
  let forwardRepairOperationId = record.forwardRepairOperationId;
  let retainedApplication = false;
  if (forwardRepairOperationId !== null) {
    const replayedOperationId = runForwardRepair(imported, choices, record.sourcePath);
    if (replayedOperationId !== forwardRepairOperationId) {
      throw new Error("migration Forward Repair replay did not match its retained receipt");
    }
  } else {
    try {
      if (completedBaseline || applicationBaseline) verifyLegacyImportApplicationTargets(application);
      else verifyLegacyImportApplicationResult(application);
      retainedApplication = true;
    } catch (verificationError) {
      const assessed = executeLegacyImportRecoveryAction(loadVerifiedRecoverApplication(imported.application.operationId), "assess");
      if (assessed.status !== "assessed"
        || assessed.assessment.decision !== "forward-repair-required"
        || !["LATER_CANONICAL_OPERATION", "AUTHORITY_CUTOVER_COMMITTED"].includes(assessed.assessment.reasonCode)) {
        throw verificationError;
      }
      forwardRepairOperationId = runForwardRepair(imported, choices, record.sourcePath);
    }
  }

  const projectionBase = captureCurrentLegacyImportBaseSnapshot();
  if (!retainedApplication) {
    record = updateMigrationPublication(record, {
      managedProjectionPaths: [...new Set([
        ...record.managedProjectionPaths,
        ...canonicalForwardMigrationProjection().map((target) => target.logicalPath),
      ])].sort(),
    });
  }
  if (retainedApplication) {
    const expectedRevision = completedBaseline ? baselineCompletionRevision : application.resultingProjectRevision;
    const expectedEpoch = completedBaseline ? baselineCompletionEpoch : application.resultingAuthorityEpoch;
    if (!sameAuthority(projectionBase.authority, expectedRevision, expectedEpoch)) {
      throw new Error("canonical authority advanced before migration projection; retry retained Application");
    }
  }
  const projection = immediateTransaction(() => {
    const locked = captureCurrentLegacyImportBaseSnapshot();
    if (!sameAuthority(
      locked.authority,
      projectionBase.authority.revision,
      projectionBase.authority.authority_epoch,
    )) {
      throw new Error("canonical authority advanced while migration projection was fenced; retry retained Application");
    }
    let currentVerification: MigrationProjectionVerification;
    if (retainedApplication) {
      if (completedBaseline || applicationBaseline) verifyLegacyImportApplicationTargets(application);
      else verifyLegacyImportApplicationResult(application);
      publishRetainedProjection(record, sourcePaths, true);
      currentVerification = completedBaseline || applicationBaseline
        ? verifyRetainedMigrationProjection(record.targetRoot, record.preview, imported)
        : verifyAppliedMigrationProjection(record.targetRoot, record.preview, imported);
    } else {
      publishCanonicalProjection(record, imported);
      currentVerification = verifyForwardRepairedMigrationProjection(
        record.targetRoot,
        imported,
        forwardRepairOperationId!,
      );
    }
    const projected = captureCurrentLegacyImportBaseSnapshot();
    return {
      verification: currentVerification,
      revision: projected.authority.revision,
      authorityEpoch: projected.authority.authority_epoch,
    };
  });
  const { verification } = projection;
  const projectionRevision = completedBaseline && initial.projectionRevision !== null
    ? initial.projectionRevision
    : projection.revision;
  const projectionAuthorityEpoch = completedBaseline && initial.projectionAuthorityEpoch !== null
    ? initial.projectionAuthorityEpoch
    : projection.authorityEpoch;
  record = updateMigrationPublication(record, {
    phase: "projected",
    forwardRepairOperationId,
    verification,
    projectionRevision,
    projectionAuthorityEpoch,
    completedResult: null,
    completionRevision: null,
    completionAuthorityEpoch: null,
    outputHashes: [],
  });

  if (record.completedAt === null) {
    record = updateMigrationPublication(record, { completedAt: new Date().toISOString() });
  }
  const completedAt = record.completedAt;
  if (completedAt === null) throw new Error("migration publication lost its completion timestamp");

  const legacyArchive = await archiveLegacyPlanningDirectory(
    evidence.legacyPath,
    record.targetRoot,
    record.sourcePath,
  );
  verification.dbReadiness = await assertMigrationDbReadiness(record.targetRoot, record.preview, imported);
  const auditFiles = await writeMigrationAudit({
    sourcePath: record.sourcePath,
    targetRoot: record.targetRoot,
    backupPath: record.backup.backupPath,
    preview: record.preview,
    written,
    imported,
    legacyArchive,
    verification,
    startedAt: record.startedAt,
    completedAt,
  }, false);
  const outputHashes = syncMigrationPublicationOutputs(record, [
    legacyArchive.archivePath,
    legacyArchive.manifestPath,
    auditFiles.migrationPath,
    auditFiles.manifestPath,
  ]);
  const beforeAudit = captureCurrentLegacyImportBaseSnapshot();
  const expectedPublishedRevision = completedBaseline ? baselineCompletionRevision : projectionRevision;
  const expectedPublishedEpoch = completedBaseline ? baselineCompletionEpoch : projectionAuthorityEpoch;
  if (!sameAuthority(beforeAudit.authority, expectedPublishedRevision, expectedPublishedEpoch)) {
    throw new Error("canonical authority advanced while migration outputs were published; retry retained Application");
  }
  const recordedAudit = recordMigrationAuditArtifacts(
    record.targetRoot,
    record.publicationKey,
    forwardRepairOperationId ?? imported.application.operationId,
    projectionRevision,
    projectionAuthorityEpoch,
  );
  const importedArtifacts = recordedAudit.importedArtifacts;
  const completionRevision = recordedAudit.operation.resultingRevision;
  const completionAuthorityEpoch = recordedAudit.operation.resultingAuthorityEpoch;
  const reprovedVerification = retainedApplication
    ? verifyRetainedMigrationProjection(record.targetRoot, record.preview, imported)
    : verifyForwardRepairedMigrationProjection(record.targetRoot, imported, forwardRepairOperationId!);
  reprovedVerification.dbReadiness = verification.dbReadiness;
  const reprovedOutputHashes = syncMigrationPublicationOutputs(record, [
    legacyArchive.archivePath,
    legacyArchive.manifestPath,
    auditFiles.migrationPath,
    auditFiles.manifestPath,
  ]);
  if (JSON.stringify(reprovedOutputHashes) !== JSON.stringify(outputHashes)) {
    throw new Error("migration publication outputs changed before completion");
  }
  const finalVerification = retainedApplication
    ? verifyRetainedMigrationProjection(record.targetRoot, record.preview, imported)
    : verifyForwardRepairedMigrationProjection(record.targetRoot, imported, forwardRepairOperationId!);
  finalVerification.dbReadiness = reprovedVerification.dbReadiness;
  const audit = { ...auditFiles, importedArtifacts };
  const result = { backup: record.backup, written, imported, legacyArchive, verification: finalVerification, audit };
  assertMigrationProjectionRootIdentity(record);
  updateMigrationPublication(record, {
    phase: "complete",
    imported,
    verification: finalVerification,
    completedResult: result,
    completionRevision,
    completionAuthorityEpoch,
    auditOperationId: recordedAudit.operation.operationId,
    outputHashes,
  });
  return result;
}

export async function assertMigrationDbReadiness(
  targetRoot: string,
  preview: MigrationPreview,
  imported?: MigrationImportCounts,
): Promise<{ phase: string; registry: number }> {
  invalidateStateCache();
  const state = await deriveState(targetRoot);
  const dbUnavailable = state.blockers.some((blocker) => blocker.includes("DB unavailable"));
  if (dbUnavailable) {
    throw new Error(`migration DB readiness failed: ${state.blockers.join("; ")}`);
  }
  const requiredMilestones = imported?.hierarchy.milestones ?? preview.milestoneCount;
  if (state.registry.length < requiredMilestones) {
    throw new Error(`migration DB readiness failed: registry ${state.registry.length}/${requiredMilestones}`);
  }
  return {
    phase: state.phase,
    registry: state.registry.length,
  };
}

/**
 * Staging trees younger than this may belong to a concurrent in-flight
 * migration; only older trees are treated as SIGKILL leak remnants.
 */
const MIGRATION_STAGING_STALE_MS = 60 * 60 * 1000;

export function sweepStaleMigrationStaging(targetRoot: string, now: number = Date.now()): void {
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(MIGRATION_STAGING_DIR_PREFIX)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const path = join(targetRoot, entry.name);
    if (now - lstatSync(path).mtimeMs < MIGRATION_STAGING_STALE_MS) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

export async function executeMigrationWrite(
  sourcePath: string,
  targetRoot: string,
  project: GSDProject,
  preview: MigrationPreview,
  startedAt: string = new Date().toISOString(),
  choices: readonly Readonly<LegacyImportForwardRepairChoice>[] = [],
): Promise<MigrationExecutionResult> {
  const projectionRootIdentity = proveMigrationProjectionRoot(targetRoot);
  sweepStaleMigrationStaging(targetRoot);
  pruneMigrationPublications(targetRoot, projectionRootIdentity);
  const stagingRoot = mkdtempSync(join(targetRoot, MIGRATION_STAGING_DIR_PREFIX));

  try {
    const staged = await writeGSDDirectory(project, stagingRoot);
    const stagedGsd = join(stagingRoot, ".gsd");
    const requestHash = migrationPublicationRequestHash(sourcePath, stagedGsd);
    const retained = findMigrationPublication(sourcePath, targetRoot, requestHash, projectionRootIdentity);
    if (retained) {
      const evidence = materializeMigrationPublicationEvidence(retained, join(stagingRoot, "retained"));
      return await completeMigrationPublication(retained, choices, evidence);
    }
    if (findPendingMigrationPublication(sourcePath, targetRoot, projectionRootIdentity)) {
      throw new Error("pending migration Application evidence differs from the current source; restore the reviewed source before retrying");
    }
    const backup = prepareMigrationTarget(targetRoot, new Date(), projectionRootIdentity);
    const preparedProjectionRootIdentity = proveMigrationProjectionRoot(targetRoot);
    const publication = prepareMigrationPublication({
      sourcePath,
      targetRoot,
      requestHash,
      startedAt,
      preview,
      backup,
      stagedGsd,
      staged,
      expectedTargets: expectedMigrationTargets(project),
      projectionRootIdentity: preparedProjectionRootIdentity,
    });
    const evidence = materializeMigrationPublicationEvidence(publication, join(stagingRoot, "retained"));
    return await completeMigrationPublication(publication, choices, evidence);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
