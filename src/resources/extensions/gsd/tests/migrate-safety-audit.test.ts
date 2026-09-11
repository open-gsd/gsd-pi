// gsd-pi - /gsd migrate safety and audit regression tests.
// File Purpose: Verifies migration hardening contracts for backup, target selection, archive, and DB projections.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { generatePreview } from "../migrate/preview.ts";
import {
  assertMigrationHasSlices,
  assertMigrationTargetAvailable,
  prepareMigrationTarget,
  resolveMigrationPaths,
} from "../migrate/safety.ts";
import {
  archiveLegacyPlanningDirectory,
  canonicalForwardMigrationProjection,
  canonicalMigrationArtifactProjection,
  inspectCommittedMigrationAudit,
  managedStructuredProjectionPaths,
  verifyMigrationProjection,
} from "../migrate/audit.ts";
import { assertMigrationDbReadiness, executeMigrationWrite, importWrittenMigrationToDb, migrationFailureMessage, sweepStaleMigrationStaging } from "../migrate/execution.ts";
import { formatPlan, formatRoadmap, writeGSDDirectory } from "../migrate/writer.ts";
import {
  _setManagedMutationBoundaryForTest,
  _setProjectionCopyBoundaryForTest,
  atomicWriteSync,
  copyProjectionFileSync,
  createProjectionDirectorySync,
  removeLegacyProjectionTreeSync,
  removeProjectionFileSync,
  removeProjectionTreeSync,
} from "../atomic-write.ts";
import {
  beginManagedProjectionMutation,
  applyManagedProjectionMutation,
  retainManagedProjectionMutation,
  _setLegacyProjectionCleanupBoundaryForTest,
  _setLegacyProjectionCleanupExchangeFaultForTest,
  _setManagedProjectionApplyFaultForTest,
  _setUnboundEvidenceCopyFaultForTest,
  _setUnboundEvidenceGuardFaultForTest,
  _setUnboundEvidenceAcknowledgementFaultForTest,
  _setUnboundEvidenceRemovalFaultForTest,
  _setUnboundEvidenceResolutionFaultForTest,
  loadUnboundProjectionEvidence,
  loadManagedProjectionPaths,
  previewUnboundProjectionEvidenceResolution,
  resolveUnboundProjectionEvidence,
} from "../managed-projection-history.ts";
import { renderAllFromDb, renderMilestoneArtifactsFromDb, renderRoadmapFromDb } from "../markdown-renderer.ts";
import { gsdRoot } from "../paths.ts";
import { _getAdapter, closeDatabase, getArtifact, getMilestone, getSliceTasks, insertArtifact, insertMilestone, openDatabase } from "../gsd-db.ts";
import { _setDomainOperationFaultForTest, executeDomainOperation } from "../db/domain-operation.ts";
import { hashLegacyImportValue } from "../legacy-import-preview.ts";
import type { GSDProject } from "../migrate/types.ts";
import {
  _setProjectionMutationBoundaryForTest,
  _setMigrationPublicationPlatformForTest,
  _setMigrationDirectorySyncForTest,
  findPendingMigrationPublication,
  findMigrationPublication,
  migrationPublicationRequestHash,
  writeMigrationProjectionFile,
  prepareMigrationPublication,
  proveMigrationProjectionRoot,
  pruneMigrationPublications,
  syncMigrationPublicationOutputs,
} from "../migrate/publication-store.ts";
import { parseMigrationRecoveryArgs } from "../migrate/command.ts";
import { withDatabaseMaintenanceClaim } from "../db/engine.ts";
import { claimProjectionMaintenance } from "../database-maintenance-fence.ts";
import { removeProjectionIfCurrent } from "../projection-cleanup.ts";
import { classifyGsdLogicalPath } from "../projection-path-policy.ts";
import { _removeDependsOnFromContextFilesForTest } from "../guided-flow-queue.ts";
import { _removeContextDraftProjectionForTest } from "../tools/workflow-tool-executors.ts";
import { parkMilestone } from "../milestone-actions.ts";
import { acquireProjectionRootIdentityLock } from "@gsd/native/file-identity";

function makeBase(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(base: string): void {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function nativeEvidenceDescriptor(
  sourcePath: string,
  logicalPath: string,
  evidenceIdentity: string,
  content: string,
  reason: string,
): { evidencePath: string; name: string; value: Record<string, unknown> } {
  const tokenBase = {
    version: 2,
    sequence: 1,
    kind: "quarantine",
    scope: "file",
    sourcePath,
    evidenceIdentity,
    logicalPath,
    contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    reason,
  } as const;
  const tokenBinding = [
    tokenBase.version,
    tokenBase.sequence,
    tokenBase.kind,
    tokenBase.scope,
    tokenBase.evidenceIdentity,
    tokenBase.sourcePath,
    tokenBase.logicalPath,
    tokenBase.contentDigest,
    tokenBase.reason,
  ].join("\0");
  const hex = createHash("sha256").update(`native-evidence\0${tokenBinding}`).digest("hex");
  const token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const sourceDirectory = dirname(sourcePath).replaceAll("\\", "/");
  const evidencePath = `${sourceDirectory === "." ? "" : `${sourceDirectory}/`}.gsd-projection-remove-${token}`;
  const base = {
    version: tokenBase.version,
    sequence: tokenBase.sequence,
    phase: "retained",
    kind: tokenBase.kind,
    scope: tokenBase.scope,
    evidencePath,
    sourcePath: tokenBase.sourcePath,
    evidenceIdentity: tokenBase.evidenceIdentity,
    logicalPath: tokenBase.logicalPath,
    contentDigest: tokenBase.contentDigest,
    reason: tokenBase.reason,
  } as const;
  const binding = Object.values(base).join("\0");
  const checksum = `sha256:${createHash("sha256").update(`native-evidence-checksum\0${token}\0${binding}`).digest("hex")}`;
  return { evidencePath, name: `${token}.json`, value: { ...base, token, checksum } };
}

function setNativeMutationBoundaryFault(
  handle: ReturnType<typeof acquireProjectionRootIdentityLock>,
  fault: "remove-file-content" | "remove-tree-content" | "publish-tree-content" | "remove-tree-crash" | "publish-tree-crash" | "publish-tree-final-content" | "remove-tree-manifest-crash" | "remove-tree-manifest-write-crash" | "publish-tree-source-replacement" | "publish-tree-new-descendant" | "remove-tree-snapshot-child" | "publish-tree-post-rename-crash" | "publish-tree-final-source-content" | "remove-tree-retirement-racer" | "publish-tree-snapshot-copy-crash" | "publish-tree-final-rename-racer" | null,
): void {
  (handle as unknown as { setMutationBoundaryFaultForTest(value: typeof fault): void })
    .setMutationBoundaryFaultForTest(fault);
}

function artifactEvidence(base: string, paths: readonly string[]): Array<{ logicalPath: string; sha256: string }> {
  return paths.map((path) => ({
    logicalPath: relative(gsdRoot(base), path).replaceAll("\\", "/"),
    sha256: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  }));
}

function createPlanningSource(base: string): string {
  const planning = join(base, ".planning");
  mkdirSync(planning, { recursive: true });
  write(join(planning, "config.json"), `${JSON.stringify({ projectName: "legacy" })}\n`);
  write(join(planning, "quick", "001-fix", "001-PLAN.md"), "# Quick task\n");
  write(join(planning, "STATE.md"), "# State\n\n**Status:** in-progress\n");
  return planning;
}

function projectFixture(): GSDProject {
  return {
    projectContent: "# Migrated Project\n\nA legacy project.\n",
    decisionsContent: "",
    requirements: [],
    milestones: [
      {
        id: "M001",
        title: "Migration",
        vision: "Carry the legacy work forward.",
        successCriteria: [],
        research: null,
        boundaryMap: [],
        slices: [
          {
            id: "S01",
            title: "First Slice",
            risk: "medium",
            depends: [],
            done: false,
            demo: "First slice works.",
            goal: "First slice works.",
            research: null,
            summary: null,
            tasks: [
              {
                id: "T01",
                title: "First Task",
                description: "Implement the first task.",
                done: false,
                estimate: "",
                files: [],
                mustHaves: [],
                summary: null,
              },
            ],
          },
        ],
      },
    ],
  };
}

let acceptedOperationSequence = 0;

function recordAcceptedOperation(operationType: string, mutate: () => void): void {
  const authority = _getAdapter()!.prepare(
    "SELECT revision, authority_epoch FROM project_authority WHERE singleton = 1",
  ).get()!;
  acceptedOperationSequence++;
  executeDomainOperation({
    operationType,
    idempotencyKey: `migration-review/${acceptedOperationSequence}`,
    expectedRevision: Number(authority["revision"]),
    expectedAuthorityEpoch: Number(authority["authority_epoch"]),
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType },
  }, () => {
    mutate();
    return {
      events: [{
        eventType: operationType,
        entityType: "migration",
        entityId: operationType,
        payload: { operationType },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `migration-review/${acceptedOperationSequence}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

test("resolveMigrationPaths treats explicit source as target project root", () => {
  const cwd = "/tmp/current";

  assert.deepEqual(
    resolveMigrationPaths("/tmp/legacy-project", cwd),
    {
      sourcePath: "/tmp/legacy-project/.planning",
      targetRoot: "/tmp/legacy-project",
    },
  );

  assert.deepEqual(
    resolveMigrationPaths("/tmp/legacy-project/.planning", cwd),
    {
      sourcePath: "/tmp/legacy-project/.planning",
      targetRoot: "/tmp/legacy-project",
    },
  );
});

test("prepareMigrationTarget backs up projections without replacing database authority", () => {
  const base = makeBase("gsd-migrate-safety-");
  try {
    write(join(base, ".gsd", "STALE.md"), "old state\n");
    write(join(base, ".gsd", "gsd.db"), "canonical database authority\n");

    const backup = prepareMigrationTarget(base, new Date(2026, 4, 20, 12, 34, 56));
    assert.equal(backup.hadExistingGsd, true);
    assert.equal(basename(backup.backupPath!), "migrate-20260520-123456");
    assert.equal(existsSync(join(backup.backupPath!, "STALE.md")), true);
    assert.equal(existsSync(join(backup.backupPath!, "gsd.db")), false);
    assert.equal(readFileSync(join(base, ".gsd", "gsd.db"), "utf8"), "canonical database authority\n");
  } finally {
    cleanup(base);
  }
});

test("assertMigrationHasSlices blocks zero-slice migrations", () => {
  assert.throws(
    () => assertMigrationHasSlices({
      decisions: { total: 0 },
      milestoneCount: 1,
      totalSlices: 0,
      totalTasks: 0,
      doneSlices: 0,
      doneTasks: 0,
      sliceCompletionPct: 0,
      taskCompletionPct: 0,
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, total: 0 },
    }),
    /zero slices/,
  );
});

test("migration failure reporting does not claim committed authority was restored", () => {
  const message = migrationFailureMessage(new Error("post-commit projection failed"));
  assert.match(message, /committed Import Application was retained/);
  assert.doesNotMatch(message, /previous .* restored/i);
});

test("migration rehashes retained artifacts immediately before Application", async () => {
  const base = makeBase("gsd-migrate-artifact-rehash-");
  const stagedRoot = makeBase("gsd-migrate-artifact-rehash-stage-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const staged = await writeGSDDirectory(projectFixture(), stagedRoot);
    const artifact = staged.artifactPaths[0]!;
    const logicalPath = artifact.slice(gsdRoot(stagedRoot).length + 1);
    await assert.rejects(
      () => importWrittenMigrationToDb(
        base,
        staged.paths,
        generatePreview(projectFixture()),
        gsdRoot(stagedRoot),
        undefined,
        [{ logicalPath, sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }],
      ),
      /retained artifact changed/i,
    );
  } finally {
    cleanup(base);
    rmSync(stagedRoot, { recursive: true, force: true });
  }
});

test("migration preserves decision amendment chains in its single Application", async () => {
  const base = makeBase("gsd-migrate-decision-amendments-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const project = projectFixture();
    project.decisionsContent = `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable | Made By |
|---|------|-------|----------|--------|-----------|-----------|---------|
| D001 | M001 | storage | Initial persistence | SQLite | Canonical state | Yes | human |
| D002 | M001/S01 | storage | Refine persistence (amends D001) | WAL | Concurrent reads | Yes | agent |
`;

    const result = await executeMigrationWrite(planning, base, project, generatePreview(project));

    assert.equal(result.imported.decisions, 2);
    const decisions = _getAdapter()!.prepare(`
      SELECT structured_fields FROM memories WHERE category = 'architecture'
    `).all().map((row) => JSON.parse(String(row["structured_fields"])))
      .map((decision) => ({ id: decision.sourceDecisionId, superseded_by: decision.superseded_by }))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(
      decisions,
      [
        { id: "D001", superseded_by: "D002" },
        { id: "D002", superseded_by: null },
      ],
    );
  } finally {
    cleanup(base);
  }
});

test("assertMigrationTargetAvailable blocks existing worktree state", async () => {
  const base = makeBase("gsd-migrate-worktree-block-");
  try {
    write(join(base, ".gsd", "worktrees", "M001", "marker"), "active worktree\n");
    await assert.rejects(
      () => assertMigrationTargetAvailable(base),
      /worktree state/,
    );
  } finally {
    cleanup(base);
  }
});

test("archiveLegacyPlanningDirectory preserves unmodeled legacy content with manifest", async () => {
  const base = makeBase("gsd-migrate-archive-");
  try {
    const planning = createPlanningSource(base);
    const archive = await archiveLegacyPlanningDirectory(planning, base);

    assert.equal(archive.archived, true);
    assert.equal(existsSync(join(base, ".gsd", "migration", "legacy", "planning", "quick", "001-fix", "001-PLAN.md")), true);
    assert.equal(existsSync(join(base, ".gsd", "migration", "legacy", "planning", "config.json")), true);

    const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf-8"));
    assert.equal(manifest.strategy, "full-source-copy");
  } finally {
    cleanup(base);
  }
});

test("executeMigrationWrite preserves committed authority when later verification fails", async () => {
  const base = makeBase("gsd-migrate-restore-");
  try {
    const planning = createPlanningSource(base);
    write(join(base, ".gsd", "OLD.md"), "known-good state\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M900", title: "Accepted authority", status: "active" });

    const project = projectFixture();
    const preview = generatePreview(project);

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, { ...preview, totalTasks: preview.totalTasks + 1 }),
      /migration DB import verification failed/,
    );

    assert.ok(getMilestone("M900"), "existing authority is preserved");
    assert.ok(getMilestone("M001"), "committed Import Application is not raw-rolled back");
    assert.equal(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 1);
    assert.equal(existsSync(join(base, ".gsd", "OLD.md")), true, "existing projection remains");
    assert.equal(existsSync(join(base, ".gsd", "migration", "MIGRATION.md")), false, "failed audit output removed");
  } finally {
    cleanup(base);
  }
});

test("executeMigrationWrite records audit artifacts and verifies DB-backed projection", async () => {
  const base = makeBase("gsd-migrate-success-");
  try {
    const planning = createPlanningSource(base);
    write(join(base, ".gsd", "STALE.md"), "old state\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M900", title: "Accepted authority", status: "active" });

    const project = projectFixture();
    project.requirements = [{
      id: "R001",
      title: "Migration requirement",
      class: "core-capability",
      status: "active",
      description: "Preserve the reviewed migration evidence.",
      source: "migration",
      primarySlice: "S01",
    }];
    project.decisionsContent = [
      "# Decisions Register",
      "",
      "| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |",
      "|---|------|-------|----------|--------|-----------|------------|---------|",
      "| D001 | migration | legacy-import | Preserve evidence | Preserve evidence | Reviewed migration | Yes | human |",
      "",
    ].join("\n");
    project.milestones[0]!.research = "# Migration Research\n\nReviewed artifact evidence.\n";
    const preview = generatePreview(project);
    const result = await executeMigrationWrite(planning, base, project, preview);

    assert.deepEqual(
      result.written.artifactPaths.map((path) => path.slice(gsdRoot(base).length + 1)).sort(),
      [
        "PROJECT.md",
        "STATE.md",
        "milestones/M001/M001-CONTEXT.md",
        "milestones/M001/M001-RESEARCH.md",
      ],
    );
    for (const artifactPath of result.written.artifactPaths) {
      const logicalPath = artifactPath.slice(gsdRoot(base).length + 1);
      assert.equal(getArtifact(`.gsd/${logicalPath}`)?.full_content, readFileSync(artifactPath, "utf8"));
    }

    assert.equal(existsSync(join(base, ".gsd", "STALE.md")), true, "migration does not replace existing authority state");
    assert.equal(existsSync(join(result.backup.backupPath!, "STALE.md")), true, "old .gsd was backed up");
    assert.equal(existsSync(join(base, ".gsd", "migration", "MIGRATION.md")), true);
    assert.equal(existsSync(join(base, ".gsd", "migration", "manifest.json")), true);
    assert.equal(existsSync(join(base, ".gsd", "migration", "legacy", "planning", "STATE.md")), true);

    assert.ok(getArtifact("migration/MIGRATION.md"), "migration audit imported as DB artifact");
    assert.ok(getArtifact("migration/manifest.json"), "migration manifest imported as DB artifact");
    const db = _getAdapter()!;
    const application = db.prepare("SELECT backup_ref FROM workflow_import_applications").get();
    assert.ok(application, "migration commits through the verified Import Application boundary");
    assert.equal(existsSync(String(application.backup_ref)), true, "migration retains its verified import backup");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'migration.artifacts'").get()?.["count"],
      0,
      "preserved artifacts are part of the single Import Application",
    );
    assert.deepEqual(result.imported.hierarchy, { milestones: 1, slices: 1, tasks: 1 });
    assert.deepEqual(result.verification.db, { milestones: 2, slices: 1, tasks: 1 });
    assert.deepEqual(result.verification.markdown, { milestones: 1, slices: 1, tasks: 1 });
    assert.equal(result.verification.importedTargets.length, result.written.paths.length);
    assert.ok(result.imported.application, "verification retains exact Import Application evidence");
    assert.equal(result.verification.applicationOperationId, result.imported.application.operationId);
    const importedKinds = new Set(result.imported.application.targets.map((target) => target.targetKind));
    for (const kind of ["decision", "milestone", "requirement", "slice", "task"]) {
      assert.equal(importedKinds.has(kind), true, `retained Application binds ${kind} targets`);
    }
    assert.equal([...importedKinds].some((kind) => kind.includes("artifact")), true, "retained Application binds artifact targets");
    assert.equal(result.imported.application.projectionTargets.length, result.written.paths.length);
    assert.ok(result.imported.application.targets.every((target) => /^sha256:[a-f0-9]{64}$/.test(target.contentHash)));
    const auditOperation = db.prepare(`
      SELECT operation_id FROM workflow_operations WHERE operation_type = 'migration.audit'
    `).get();
    assert.ok(auditOperation, "audit artifacts use the canonical Domain Operation boundary");
    for (const table of ["workflow_domain_events", "workflow_outbox", "workflow_projection_work"]) {
      assert.ok(Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.["count"]) > 0);
    }
    assert.equal(
      readFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8"),
      formatRoadmap(project.milestones[0]!),
    );
    assert.equal(
      readFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), "utf8"),
      formatPlan(project.milestones[0]!.slices[0]!),
    );
    assert.equal(result.verification.dbReadiness.registry, 2, "imported and preserved authority are readable by deriveState");
    assert.notEqual(result.verification.dbReadiness.phase, "not-checked", "readiness gate ran before audit");
  } finally {
    cleanup(base);
  }
});

test("completed milestone artifacts retain exact canonical bytes", async () => {
  const base = makeBase("gsd-migrate-completed-artifacts-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    project.milestones[0]!.slices[0]!.done = true;
    project.milestones[0]!.slices[0]!.tasks[0]!.done = true;
    project.milestones[0]!.slices[0]!.research = "# Slice Research\n\nRetain these mixed-content notes.\n";
    const result = await executeMigrationWrite(planning, base, project, generatePreview(project));
    const expected = [
      "milestones/M001/M001-VALIDATION.md",
      "milestones/M001/M001-SUMMARY.md",
    ];
    for (const logicalPath of expected) {
      assert.ok(result.written.artifactPaths.some((path) => path.endsWith(logicalPath)));
      assert.equal(
        getArtifact(`.gsd/${logicalPath}`)?.full_content,
        readFileSync(join(base, ".gsd", logicalPath), "utf8"),
      );
    }
    assert.equal(getSliceTasks("M001", "S01")[0]?.status, "complete");
    assert.equal(
      getArtifact(".gsd/milestones/M001/slices/S01/S01-RESEARCH.md")?.full_content,
      project.milestones[0]!.slices[0]!.research,
    );
  } finally {
    cleanup(base);
  }
});

test("assertMigrationDbReadiness fails loud when deriveState cannot see migrated rows", async () => {
  const base = makeBase("gsd-migrate-db-readiness-");
  try {
    const project = projectFixture();
    const preview = generatePreview(project);
    await writeGSDDirectory(project, base);

    await assert.rejects(
      () => assertMigrationDbReadiness(base, preview),
      /migration DB readiness failed/,
    );
  } finally {
    cleanup(base);
  }
});

test("verifyMigrationProjection fails when DB hierarchy diverges from preview", async () => {
  const base = makeBase("gsd-migrate-projection-");
  try {
    const project = projectFixture();
    const preview = generatePreview(project);
    const written = await writeGSDDirectory(project, base);
    await importWrittenMigrationToDb(
      base,
      written.paths,
      preview,
      gsdRoot(base),
      undefined,
      artifactEvidence(base, written.artifactPaths),
    );

    await assert.rejects(
      () => verifyMigrationProjection(base, { ...preview, totalTasks: preview.totalTasks + 1 }),
      /DB hierarchy/,
    );
  } finally {
    cleanup(base);
  }
});

test("verifyMigrationProjection binds every imported target to its rendered content", async () => {
  const base = makeBase("gsd-migrate-target-proof-");
  try {
    const project = projectFixture();
    const preview = generatePreview(project);
    const written = await writeGSDDirectory(project, base);
    const imported = await importWrittenMigrationToDb(
      base,
      written.paths,
      preview,
      gsdRoot(base),
      undefined,
      artifactEvidence(base, written.artifactPaths),
    );
    const [first, ...rest] = imported.application.projectionTargets;
    assert.ok(first);
    const tampered = {
      ...imported,
      application: {
        ...imported.application,
        projectionTargets: [{ ...first, sha256: `sha256:${"0".repeat(64)}` }, ...rest],
      },
    };
    await assert.rejects(
      () => verifyMigrationProjection(base, preview, tampered),
      /projection evidence did not match its retained Import Application/,
    );
  } finally {
    cleanup(base);
  }
});

test("verifyMigrationProjection independently rejects incorrect canonical target rows", async () => {
  const base = makeBase("gsd-migrate-canonical-target-proof-");
  try {
    const project = projectFixture();
    const preview = generatePreview(project);
    const written = await writeGSDDirectory(project, base);
    const imported = await importWrittenMigrationToDb(
      base,
      written.paths,
      preview,
      gsdRoot(base),
      undefined,
      artifactEvidence(base, written.artifactPaths),
    );
    _getAdapter()!.prepare("UPDATE milestones SET title = 'incorrect result' WHERE id = 'M001'").run();

    await assert.rejects(
      () => verifyMigrationProjection(base, preview, imported),
      /canonical target .* did not match retained Application content/,
    );
  } finally {
    cleanup(base);
  }
});

test("verifyMigrationProjection rejects an incorrect imported artifact count", async () => {
  const base = makeBase("gsd-migrate-artifact-count-");
  try {
    const project = projectFixture();
    const preview = generatePreview(project);
    const written = await writeGSDDirectory(project, base);
    const imported = await importWrittenMigrationToDb(
      base,
      written.paths,
      preview,
      gsdRoot(base),
      undefined,
      artifactEvidence(base, written.artifactPaths),
    );

    await assert.rejects(
      () => verifyMigrationProjection(base, preview, { ...imported, artifacts: imported.artifacts + 1 }),
      /artifact target count/,
    );
  } finally {
    cleanup(base);
  }
});

test("verifyMigrationProjection rejects staged files after later canonical work", async () => {
  const base = makeBase("gsd-migrate-later-write-");
  try {
    const project = projectFixture();
    const preview = generatePreview(project);
    const written = await writeGSDDirectory(project, base);
    const imported = await importWrittenMigrationToDb(
      base,
      written.paths,
      preview,
      gsdRoot(base),
      undefined,
      artifactEvidence(base, written.artifactPaths),
    );
    recordAcceptedOperation("migration-review.later-work", () => {
      insertMilestone({ id: "M900", title: "Later accepted work", status: "active" });
    });
    await assert.rejects(
      () => verifyMigrationProjection(base, preview, imported),
      /canonical authority advanced after the retained Import Application/,
    );
  } finally {
    cleanup(base);
  }
});

test("executeMigrationWrite resumes publication without another Import Application", async () => {
  const base = makeBase("gsd-migrate-publication-replay-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);

    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"],
      1,
    );
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });

    const replay = await executeMigrationWrite(planning, base, project, preview);
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"],
      1,
    );
    assert.equal(existsSync(join(base, ".gsd", "PROJECT.md")), true);
    assert.equal(replay.verification.applicationOperationId, replay.imported.application.operationId);
  } finally {
    cleanup(base);
  }
});

test("migration publication rejects symbolic links in reviewed evidence", async () => {
  const base = makeBase("gsd-migrate-publication-symlink-");
  try {
    const planning = createPlanningSource(base);
    const staged = join(base, "staged");
    mkdirSync(staged, { recursive: true });
    write(join(staged, "PROJECT.md"), "# Project\n");
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    write(join(outside, "secret.md"), "outside reviewed evidence\n");
    symlinkSync(outside, join(planning, "linked"), "dir");

    assert.throws(
      () => migrationPublicationRequestHash(planning, staged),
      /unsupported symbolic link/,
    );
  } finally {
    cleanup(base);
  }
});

test("migration publication rejects a symlinked projection root", () => {
  const base = makeBase("gsd-migrate-projection-root-");
  const outside = makeBase("gsd-migrate-projection-root-outside-");
  try {
    symlinkSync(outside, join(base, ".gsd"), "dir");
    assert.throws(
      () => writeMigrationProjectionFile({ targetRoot: base }, "ROADMAP.md", "roadmap\n"),
      /projection root|symbolic link/i,
    );
    assert.equal(existsSync(join(outside, "ROADMAP.md")), false);
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("migration rejects same-path projection root replacement", () => {
  const base = makeBase("gsd-migrate-root-replacement-");
  try {
    mkdirSync(join(base, ".gsd"));
    const identity = proveMigrationProjectionRoot(base);
    renameSync(join(base, ".gsd"), join(base, ".gsd-original"));
    mkdirSync(join(base, ".gsd"));

    assert.throws(
      () => prepareMigrationTarget(base, new Date(2026, 6, 18), identity),
      /projection root identity changed/i,
    );
  } finally {
    cleanup(base);
  }
});

test("migration retained copies stay bound to the reviewed projection root", async () => {
  const base = makeBase("gsd-migrate-root-aba-");
  const stagedRoot = makeBase("gsd-migrate-root-aba-stage-");
  const originalRoot = join(base, ".gsd-original");
  const replacementRoot = join(base, ".gsd-replacement");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"));
    const staged = await writeGSDDirectory(projectFixture(), stagedRoot);
    let relativeTarget = "";
    _setProjectionMutationBoundaryForTest((boundary) => {
      if (boundary === "before-copy" && relativeTarget.length === 0) {
        renameSync(join(base, ".gsd"), originalRoot);
        mkdirSync(join(base, ".gsd"));
      } else if (boundary === "after-copy" && relativeTarget.length === 0 && existsSync(join(base, ".gsd"))) {
        const populatedRoot = existsSync(join(originalRoot, "migration-applications")) ? originalRoot : join(base, ".gsd");
        const application = readdirSync(join(populatedRoot, "migration-applications"))[0]!;
        relativeTarget = join("migration-applications", application, "projection", "PROJECT.md");
        write(join(originalRoot, relativeTarget), readFileSync(join(stagedRoot, ".gsd", "PROJECT.md"), "utf8"));
        renameSync(join(base, ".gsd"), replacementRoot);
        renameSync(originalRoot, join(base, ".gsd"));
      }
    });

    prepareMigrationPublication({
      sourcePath: planning,
      targetRoot: base,
      requestHash: migrationPublicationRequestHash(planning, join(stagedRoot, ".gsd")),
      startedAt: new Date().toISOString(),
      preview: generatePreview(projectFixture()),
      backup: { backupPath: null, hadExistingGsd: true, targetGsdPath: join(base, ".gsd") },
      stagedGsd: join(stagedRoot, ".gsd"),
      staged,
      expectedTargets: [],
      projectionRootIdentity: proveMigrationProjectionRoot(base),
    });

    assert.equal(existsSync(join(replacementRoot, relativeTarget)), false);
  } finally {
    _setProjectionMutationBoundaryForTest(null);
    cleanup(base);
    rmSync(stagedRoot, { recursive: true, force: true });
  }
});

test("migration publication rejects a symlinked root before retaining evidence", async () => {
  const base = makeBase("gsd-migrate-early-symlink-root-");
  const outside = makeBase("gsd-migrate-early-symlink-outside-");
  try {
    const stagedRoot = makeBase("gsd-migrate-early-symlink-stage-");
    const staged = await writeGSDDirectory(projectFixture(), stagedRoot);
    symlinkSync(outside, join(base, ".gsd"), "dir");
    assert.throws(() => prepareMigrationPublication({
      sourcePath: createPlanningSource(base),
      targetRoot: base,
      requestHash: "sha256:early-root",
      startedAt: new Date().toISOString(),
      preview: generatePreview(projectFixture()),
      backup: { backupPath: null, hadExistingGsd: true, targetGsdPath: join(base, ".gsd") },
      stagedGsd: gsdRoot(stagedRoot),
      staged,
      expectedTargets: [],
    }), /projection root|symbolic link/i);
    assert.equal(existsSync(join(outside, "migration-applications")), false);
    rmSync(stagedRoot, { recursive: true, force: true });
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("migration rejects a symlinked root before backup or source inspection", async () => {
  const base = makeBase("gsd-migrate-root-before-backup-");
  const outside = makeBase("gsd-migrate-root-before-backup-outside-");
  try {
    const planning = createPlanningSource(base);
    write(join(outside, "existing.md"), "outside\n");
    symlinkSync(outside, join(base, ".gsd"), "dir");

    await assert.rejects(
      () => executeMigrationWrite(planning, base, projectFixture(), generatePreview(projectFixture())),
      /projection root|symbolic link/i,
    );
    assert.equal(existsSync(join(base, ".gsd-backups")), false);
    assert.equal(existsSync(join(outside, "migration-applications")), false);
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("maintenance publication fences ordinary database and projection writers", async () => {
  const base = makeBase("gsd-migrate-maintenance-fence-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    let startOutside!: () => void;
    const start = new Promise<void>((resolve) => { startOutside = resolve; });
    const outside = new Promise<void>((resolve, reject) => {
      setImmediate(async () => {
        await start;
        try {
          assert.throws(
            () => atomicWriteSync(join(base, ".gsd", "blocked.md"), "blocked\n"),
            /maintenance|fenced/i,
          );
          assert.throws(
            () => recordAcceptedOperation("migration-review.fenced", () => undefined),
            /maintenance|fenced/i,
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    await withDatabaseMaintenanceClaim(async () => {
      atomicWriteSync(join(base, ".gsd", "owner.md"), "owner\n");
      startOutside();
      await outside;
    });
    assert.equal(readFileSync(join(base, ".gsd", "owner.md"), "utf8"), "owner\n");
    assert.equal(existsSync(join(base, ".gsd", "blocked.md")), false);
  } finally {
    cleanup(base);
  }
});

test("projection deletion records managed output history before removal", () => {
  const base = makeBase("gsd-migrate-managed-delete-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const path = join(base, ".gsd", "notes", "transient.md");
    write(path, "transient\n");
    removeProjectionFileSync(path);
    assert.equal(existsSync(path), false);
    assert.ok(loadManagedProjectionPaths(base).includes("notes/transient.md"));
  } finally {
    cleanup(base);
  }
});

test("failed projection writes do not create managed-output history", () => {
  const base = makeBase("gsd-migrate-managed-failed-write-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", "notes"), "not a directory\n");
    const path = join(base, ".gsd", "notes", "never-published.md");

    assert.throws(() => atomicWriteSync(path, "unpublished\n"));
    assert.equal(loadManagedProjectionPaths(base).includes("notes/never-published.md"), false);
  } finally {
    cleanup(base);
  }
});

test("interrupted projection mutations remain recoverably discoverable", () => {
  const base = makeBase("gsd-migrate-managed-journal-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const writtenPath = join(base, ".gsd", "notes", "interrupted-write.md");
    const removedPath = join(base, ".gsd", "notes", "interrupted-remove.md");
    write(removedPath, "remove me\n");

    _setManagedMutationBoundaryForTest((boundary) => {
      if (boundary === "before-write") return;
      throw new Error(`simulated interruption ${boundary}`);
    });
    assert.throws(() => atomicWriteSync(writtenPath, "published\n"), /simulated interruption/);
    assert.throws(() => removeProjectionFileSync(removedPath), /simulated interruption/);
    _setManagedMutationBoundaryForTest(null);

    assert.deepEqual(
      loadManagedProjectionPaths(base).filter((path) => path.includes("interrupted-")),
      ["notes/interrupted-remove.md", "notes/interrupted-write.md"],
    );
    assert.equal(readFileSync(writtenPath, "utf8"), "published\n");
    assert.equal(existsSync(removedPath), false);
  } finally {
    _setManagedMutationBoundaryForTest(null);
    cleanup(base);
  }
});

test("native post-mutation failures retain recovery evidence", () => {
  const base = makeBase("gsd-migrate-managed-native-failure-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const path = join(base, ".gsd", "notes", "durability-failed.md");
    _setManagedProjectionApplyFaultForTest(() => {
      throw new Error("simulated native durability failure");
    });

    assert.throws(() => atomicWriteSync(path, "recoverable\n"), /native durability failure/);
    _setManagedProjectionApplyFaultForTest(null);

    assert.ok(loadManagedProjectionPaths(base).includes("notes/durability-failed.md"));
    assert.equal(readFileSync(path, "utf8"), "recoverable\n");
  } finally {
    _setManagedProjectionApplyFaultForTest(null);
    cleanup(base);
  }
});

test("new projection mutations recover older journals before publishing", () => {
  const base = makeBase("gsd-migrate-managed-order-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const path = join(base, ".gsd", "notes", "ordered.md");

    _setManagedMutationBoundaryForTest((boundary) => {
      if (boundary === "before-write") return;
      throw new Error("simulated stale journal");
    });
    assert.throws(() => atomicWriteSync(path, "older\n"), /simulated stale journal/);
    _setManagedMutationBoundaryForTest(null);

    atomicWriteSync(path, "newer\n");
    loadManagedProjectionPaths(base);
    assert.equal(readFileSync(path, "utf8"), "newer\n");
  } finally {
    _setManagedMutationBoundaryForTest(null);
    cleanup(base);
  }
});

test("projection mutation remains bound to the opened root identity", () => {
  const base = makeBase("gsd-migrate-managed-identity-");
  const outside = makeBase("gsd-migrate-managed-identity-outside-");
  const notes = join(base, ".gsd", "notes");
  try {
    mkdirSync(notes, { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const path = join(notes, "identity.md");

    _setManagedMutationBoundaryForTest((boundary) => {
      if (boundary !== "before-write") return;
      renameSync(notes, `${notes}-original`);
      symlinkSync(outside, notes, "dir");
    });

    assert.throws(() => atomicWriteSync(path, "must stay inside\n"), /projection root|symbolic link|identity/i);
    assert.equal(existsSync(join(outside, "identity.md")), false);
  } finally {
    _setManagedMutationBoundaryForTest(null);
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("managed projection recovery preserves unclaimed native journal temps", () => {
  const base = makeBase("gsd-migrate-managed-json-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const output = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-REOPEN.json");
    atomicWriteSync(output, "{\"state\":\"accepted\"}\n");
    const journalRoot = join(base, ".gsd", "migration", "projection-mutations");
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(join(journalRoot, ".gsd-projection-tmp-interrupted"), "partial");

    assert.throws(() => loadManagedProjectionPaths(base), /journal is invalid/i);
    assert.equal(existsSync(join(journalRoot, ".gsd-projection-tmp-interrupted")), true);
  } finally {
    cleanup(base);
  }
});

test("managed projection recovery preserves unclaimed target temps", () => {
  const base = makeBase("gsd-migrate-managed-target-temp-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const output = join(base, ".gsd", "notes", "interrupted.md");
    _setManagedMutationBoundaryForTest((boundary) => {
      if (boundary === "after-write") throw new Error("simulated interruption");
    });
    assert.throws(() => atomicWriteSync(output, "accepted\n"), /simulated interruption/);
    _setManagedMutationBoundaryForTest(null);

    const interruptedTemp = join(base, ".gsd", "notes", ".gsd-projection-tmp-interrupted.md");
    const unrelatedTemp = join(base, ".gsd", "notes", ".gsd-projection-tmp-unrelated.md");
    write(interruptedTemp, "partial");
    write(unrelatedTemp, "unrelated");

    loadManagedProjectionPaths(base);
    assert.equal(existsSync(interruptedTemp), true);
    assert.equal(existsSync(unrelatedTemp), true);
  } finally {
    _setManagedMutationBoundaryForTest(null);
    cleanup(base);
  }
});

test("managed projection writes never remove an unclaimed temporary file", () => {
  const base = makeBase("gsd-migrate-managed-unclaimed-temp-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const output = join(base, ".gsd", "notes", "report.md");
    const unclaimed = join(base, ".gsd", "notes", ".gsd-projection-tmp-report.md");
    write(unclaimed, "belongs to another operation\n");

    atomicWriteSync(output, "accepted\n");

    assert.equal(readFileSync(unclaimed, "utf8"), "belongs to another operation\n");
    assert.equal(readFileSync(output, "utf8"), "accepted\n");
  } finally {
    cleanup(base);
  }
});

test("temporary publication fails closed after a same-content identity replacement", () => {
  const base = makeBase("gsd-migrate-temp-identity-");
  const root = join(base, ".gsd");
  mkdirSync(join(root, "notes"), { recursive: true });
  const stat = lstatSync(root, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());
  try {
    const temporary = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const identity = handle.prepareFileTemporary(temporary, Buffer.from("accepted\n"));
    renameSync(join(root, temporary), join(root, `${temporary}.original`));
    write(join(root, temporary), "accepted\n");
    assert.throws(
      () => handle.publishFileTemporary("notes/result.md", temporary, identity),
      process.platform === "win32" ? /identity changed/i : /persisted exchange guard/i,
    );
    assert.equal(existsSync(join(root, "notes", "result.md")), false);
    assert.equal(readFileSync(join(root, temporary), "utf8"), "accepted\n");
  } finally {
    handle.close();
    cleanup(base);
  }
});

test("projection root identity lock excludes a concurrent mutation owner", () => {
  const base = makeBase("gsd-migrate-root-owner-");
  const root = join(base, ".gsd");
  mkdirSync(root);
  const stat = lstatSync(root, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());
  try {
    assert.throws(
      () => acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString()),
      /busy|locking failed|sharing violation/i,
    );
  } finally {
    handle.close();
    cleanup(base);
  }
});

test("journal-bound quarantine preserves a replacement identity", () => {
  const base = makeBase("gsd-migrate-quarantine-request-race-");
  const root = join(base, ".gsd");
  mkdirSync(join(root, "notes"), { recursive: true });
  const target = join(root, "notes", "result.md");
  write(target, "reviewed\n");
  const stat = lstatSync(root, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());
  try {
    const identity = handle.pathIdentity("notes/result.md");
    const placeholderIdentity = handle.prepareFileTemporary("notes/result.md.replaced", Buffer.alloc(0));
    const guardPath = "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000002";
    const guardIdentity = handle.prepareFileTemporary(guardPath, Buffer.alloc(0));
    renameSync(target, `${target}.reviewed`);
    write(target, "later accepted work\n");
    assert.throws(
      () => handle.quarantineFileIfIdentity(
        "notes/result.md",
        "notes/result.md.replaced",
        identity,
        placeholderIdentity,
        guardPath,
        guardIdentity,
      ),
      /identity changed/i,
    );
    assert.equal(readFileSync(target, "utf8"), "later accepted work\n");
    assert.equal(existsSync(join(root, "notes", "result.md.replaced")), true);
    assert.equal(existsSync(join(root, guardPath)), true);
  } finally {
    handle.close();
    cleanup(base);
  }
});

test("managed projection recovery rejects a journal targeting database authority", () => {
  const base = makeBase("gsd-migrate-journal-control-path-");
  const databasePath = join(base, ".gsd", "gsd.db");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(databasePath), true);
    const journal = join(
      base,
      ".gsd",
      "migration",
      "projection-mutations",
      "00000000-0000-0000-0000-000000000001.json",
    );
    write(journal, `${JSON.stringify({
      logicalPath: "gsd.db",
      operation: "remove",
      content: null,
      encoding: null,
      temporaryPath: null,
      temporaryIdentity: null,
      replacementPath: null,
      replacementIdentity: null,
      quarantinePath: null,
      quarantineIdentity: null,
    })}\n`);

    assert.throws(() => loadManagedProjectionPaths(base), /mutation is invalid/i);
    assert.equal(existsSync(databasePath), true);
  } finally {
    cleanup(base);
  }
});

test("managed projection recovery binds exchange paths to its mutation", () => {
  const base = makeBase("gsd-migrate-journal-exchange-binding-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    write(join(base, ".gsd", "notes", "result.md"), "reviewed\n");
    const targetIdentity = handle.pathIdentity("notes/result.md");
    const temporaryPath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const temporaryIdentity = handle.prepareFileTemporary(temporaryPath, Buffer.from("replacement\n"));
    const guardPath = "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001";
    const guardIdentity = handle.prepareFileTemporary(guardPath, Buffer.alloc(0));
    handle.close();
    write(join(base, ".gsd", "migration", "projection-mutations", "00000000-0000-0000-0000-000000000001.json"), `${JSON.stringify({
      logicalPath: "notes/result.md", operation: "write", legacyCleanup: false,
      content: Buffer.from("replacement\n").toString("base64"), encoding: "base64",
      temporaryPath, temporaryIdentity, replacementPath: `${temporaryPath}.replaced`, replacementIdentity: null,
      quarantinePath: null, quarantineIdentity: null, placeholderIdentity: null,
      exchangeGuardPath: guardPath, exchangeGuardIdentity: guardIdentity,
      exchangeState: { leftPath: "gsd.db", rightPath: temporaryPath, leftIdentity: targetIdentity, rightIdentity: temporaryIdentity, guardPath, guardIdentity },
    })}\n`);

    assert.throws(() => loadManagedProjectionPaths(base), /mutation is invalid/i);
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  } finally {
    cleanup(base);
  }
});

test("managed projection recovery binds exchange identities to its mutation", () => {
  for (const corrupted of ["leftIdentity", "rightIdentity"] as const) {
    const base = makeBase(`gsd-migrate-journal-exchange-${corrupted}-`);
    try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    write(join(base, ".gsd", "notes", "result.md"), "reviewed\n");
    const temporaryPath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const temporaryIdentity = handle.prepareFileTemporary(temporaryPath, Buffer.from("replacement\n"));
    const guardPath = "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001";
    const guardIdentity = handle.prepareFileTemporary(guardPath, Buffer.alloc(0));
    const replacementPath = `${temporaryPath}.replaced`;
    const placeholderIdentity = handle.prepareFileTemporary(replacementPath, Buffer.alloc(0));
    handle.close();
    write(join(base, ".gsd", "migration", "projection-mutations", "00000000-0000-0000-0000-000000000001.json"), `${JSON.stringify({
      logicalPath: "notes/result.md", operation: "write", legacyCleanup: false,
      content: Buffer.from("replacement\n").toString("base64"), encoding: "base64",
      temporaryPath, temporaryIdentity, replacementPath, replacementIdentity: "1:2",
      quarantinePath: null, quarantineIdentity: null, placeholderIdentity,
      exchangeGuardPath: guardPath, exchangeGuardIdentity: guardIdentity,
      exchangeState: {
        leftPath: "notes/result.md", rightPath: replacementPath,
        leftIdentity: corrupted === "leftIdentity" ? "9:9" : "1:2",
        rightIdentity: corrupted === "rightIdentity" ? "8:8" : placeholderIdentity,
        guardPath, guardIdentity,
      },
    })}\n`);

    assert.throws(() => loadManagedProjectionPaths(base), /mutation is invalid/i);
    } finally {
      cleanup(base);
    }
  }
});

test("exchange racer recovery closes its journal after retaining every participant", () => {
  const base = makeBase("gsd-migrate-exchange-racer-ledger-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const rootPath = join(base, ".gsd");
    const root = lstatSync(rootPath, { bigint: true });
    const handle = acquireProjectionRootIdentityLock(rootPath, root.dev.toString(), root.ino.toString());
    const logicalPath = "notes/result.md";
    const temporaryPath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const replacementPath = `${temporaryPath}.replaced`;
    const guardPath = "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001";
    write(join(rootPath, logicalPath), "reviewed\n");
    const targetIdentity = handle.pathIdentity(logicalPath);
    const temporaryIdentity = handle.prepareFileTemporary(temporaryPath, Buffer.from("replacement\n"));
    const placeholderIdentity = handle.prepareFileTemporary(replacementPath, Buffer.alloc(0));
    const guardIdentity = handle.prepareFileTemporary(guardPath, Buffer.alloc(0));
    renameSync(join(rootPath, replacementPath), join(rootPath, `${replacementPath}.displaced`));
    renameSync(join(rootPath, guardPath), join(rootPath, replacementPath));
    write(join(rootPath, guardPath, "racing.md"), "racing occupant\n");
    handle.close();
    const journal = join(rootPath, "migration", "projection-mutations", "00000000-0000-0000-0000-000000000001.json");
    write(journal, `${JSON.stringify({
      logicalPath,
      operation: "write",
      legacyCleanup: false,
      content: Buffer.from("replacement\n").toString("base64"),
      encoding: "base64",
      temporaryPath,
      temporaryIdentity,
      replacementPath,
      replacementIdentity: targetIdentity,
      quarantinePath: null,
      quarantineIdentity: null,
      placeholderIdentity,
      exchangeGuardPath: guardPath,
      exchangeGuardIdentity: guardIdentity,
      exchangeState: {
        leftPath: logicalPath,
        rightPath: replacementPath,
        leftIdentity: targetIdentity,
        rightIdentity: placeholderIdentity,
        guardPath,
        guardIdentity,
      },
    })}\n`);

    assert.throws(
      () => loadManagedProjectionPaths(base),
      /managed projection target identity changed; recovery evidence retained/u,
    );
    assert.equal(existsSync(journal), false);
    assert.equal(existsSync(join(rootPath, temporaryPath)), true);
    assert.equal(existsSync(join(rootPath, replacementPath)), true);
    assert.equal(existsSync(join(rootPath, guardPath)), true);
    const ledger = JSON.parse(readFileSync(join(rootPath, "migration", "unbound-projection-evidence.json"), "utf8"));
    assert.deepEqual(
      ledger.map((entry: { evidencePath: string }) => entry.evidencePath).sort(),
      [guardPath, logicalPath, replacementPath, temporaryPath].sort(),
    );
    const evidence = loadUnboundProjectionEvidence(base);
    assert.equal(evidence.length, 4);
    assert.equal(evidence.find(entry => entry.evidencePath === guardPath)?.scope, "tree");
  } finally {
    cleanup(base);
  }
});

test("evidence recovery binds its destination to the selected action", () => {
  const base = makeBase("gsd-migrate-evidence-destination-binding-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "retained\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "temporary", logicalPath: "notes/result.md", scope: "file", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "restore");
    const pathToken = (label: string): string => {
      const hex = createHash("sha256").update(`${label}\0${evidence.evidenceId}`).digest("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    };
    const ledgerPath = join(base, ".gsd", "migration", "unbound-projection-evidence.json");
    const [entry] = JSON.parse(readFileSync(ledgerPath, "utf8"));
    entry.transition = "resolving";
    entry.resolution = {
      action: "restore", currentIdentity: preview.currentIdentity, contentDigest: preview.contentDigest,
      destinationPath: "gsd.db", guardPath: `notes/.gsd-projection-remove-${pathToken("guard")}`,
      guardIdentity: null, stagingPath: `.gsd-projection-tmp-${pathToken("staging")}`,
      stagingIdentity: null, exchangeIdentity: null, phase: "prepared",
    };
    writeFileSync(ledgerPath, `${JSON.stringify([entry])}\n`);

    assert.throws(
      () => loadUnboundProjectionEvidence(base),
      /evidence is invalid/i,
    );
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  } finally {
    cleanup(base);
  }
});

test("evidence recovery binds resolution proof to retained evidence", () => {
  for (const corrupted of ["contentDigest", "currentIdentity"] as const) {
    const base = makeBase(`gsd-migrate-evidence-${corrupted}-binding-`);
    try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "retained\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "temporary", logicalPath: "notes/result.md", scope: "file", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "restore");
    _setUnboundEvidenceGuardFaultForTest(() => { throw new Error("stop after guard"); });
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "restore", preview.consent),
      /stop after guard/,
    );
    _setUnboundEvidenceGuardFaultForTest(null);
    const ledgerPath = join(base, ".gsd", "migration", "unbound-projection-evidence.json");
    const [entry] = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (corrupted === "contentDigest") entry.resolution.contentDigest = `sha256:${"0".repeat(64)}`;
    else entry.resolution.currentIdentity = "0:0";
    writeFileSync(ledgerPath, `${JSON.stringify([entry])}\n`);

    assert.throws(
      () => loadUnboundProjectionEvidence(base),
      /evidence is invalid/i,
    );
    } finally {
      _setUnboundEvidenceGuardFaultForTest(null);
      cleanup(base);
    }
  }
});

test("destructive evidence consent rechecks file content inside the removal guard", () => {
  const base = makeBase("gsd-migrate-evidence-final-file-proof-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "reviewed\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "temporary", logicalPath: "notes/result.md", scope: "file", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    _setUnboundEvidenceRemovalFaultForTest(() => {
      const [entry] = JSON.parse(readFileSync(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), "utf8"));
      writeFileSync(join(base, ".gsd", entry.resolution.guardPath), "changed after consent\n");
    });

    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /content changed inside removal guard/i,
    );
  } finally {
    _setUnboundEvidenceRemovalFaultForTest(null);
    cleanup(base);
  }
});

test("destructive evidence consent rechecks tree descendants inside the removal guard", () => {
  const base = makeBase("gsd-migrate-evidence-final-tree-proof-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    mkdirSync(join(base, ".gsd", evidencePath), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", evidencePath, "reviewed.md"), "reviewed\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "quarantine", logicalPath: "notes/result", scope: "tree", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    _setUnboundEvidenceRemovalFaultForTest(() => {
      const [entry] = JSON.parse(readFileSync(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), "utf8"));
      write(join(base, ".gsd", entry.resolution.guardPath, "later.md"), "later\n");
    });

    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /content changed inside removal guard/i,
    );
  } finally {
    _setUnboundEvidenceRemovalFaultForTest(null);
    cleanup(base);
  }
});

test("native exact removal rechecks content at its final mutation boundary", () => {
  const base = makeBase("gsd-migrate-native-final-remove-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(
      join(base, ".gsd"),
      root.dev.toString(),
      root.ino.toString(),
    );
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path), "reviewed\n");
    const identity = handle.pathIdentity(path);
    const digest = `sha256:${createHash("sha256").update("reviewed\n").digest("hex")}`;
    try {
      setNativeMutationBoundaryFault(handle, "remove-file-content");
      assert.throws(
        () => handle.removeFileViaGuardExact(path, identity, path, false, digest),
        /content changed inside removal guard/i,
      );
      assert.equal(existsSync(join(base, ".gsd", path)), true);
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("native exact tree publication proves staging before live exposure", () => {
  const base = makeBase("gsd-migrate-native-final-publish-");
  try {
    mkdirSync(join(base, ".gsd", "notes", ".gsd-projection-tmp-00000000-0000-0000-0000-000000000001"), { recursive: true });
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(
      join(base, ".gsd"),
      root.dev.toString(),
      root.ino.toString(),
    );
    const identity = handle.pathIdentity(source);
    const digest = (() => {
      const hash = createHash("sha256");
      hash.update("\0directory\0");
      hash.update("reviewed.md\0file\0");
      hash.update("reviewed\n\0");
      return `sha256:${hash.digest("hex")}`;
    })();
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-content");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, digest),
        /private snapshot content changed at publication boundary/i,
      );
      assert.equal(existsSync(join(base, ".gsd", destination)), false);
      assert.equal(existsSync(join(base, ".gsd", source)), true);
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree evidence deletion resumes from its durable deleting phase", () => {
  const base = makeBase("gsd-migrate-tree-delete-replay-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath, "one.md"), "one\n");
    write(join(base, ".gsd", evidencePath, "nested", "two.md"), "two\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "quarantine", logicalPath: "notes/result", scope: "tree", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    let handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, "remove-tree-crash");
    handle.close();

    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /simulated tree deletion crash/i,
    );
    const [resolving] = JSON.parse(readFileSync(
      join(base, ".gsd", "migration", "unbound-projection-evidence.json"),
      "utf8",
    ));
    assert.equal(resolving.resolution.phase, "deleting");
    handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, null);
    handle.close();

    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
    assert.equal(existsSync(join(base, ".gsd", evidencePath)), false);
  } finally {
    cleanup(base);
  }
});

test("tree deletion promotes a durable prepared consent manifest after restart", () => {
  const base = makeBase("gsd-migrate-tree-manifest-replay-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    let handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    setNativeMutationBoundaryFault(handle, "remove-tree-manifest-crash");
    assert.throws(
      () => handle.removeFileViaGuardExact(path, identity, path, true, digest, true),
      /prepared deletion manifest crash/i,
    );
    handle.close();

    handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, null);
    handle.removeFileViaGuardExact(path, identity, path, true, digest, true);
    handle.close();
    assert.equal(existsSync(join(base, ".gsd", path)), false);
  } finally {
    cleanup(base);
  }
});

test("tree deletion retains an unbound manifest temporary and fails closed", () => {
  const base = makeBase("gsd-migrate-tree-manifest-torn-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    let handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    setNativeMutationBoundaryFault(handle, "remove-tree-manifest-write-crash");
    assert.throws(
      () => handle.removeFileViaGuardExact(path, identity, path, true, digest, true),
      /manifest write crash/i,
    );
    handle.close();

    const directory = join(base, ".gsd", path);
    const names = readdirSync(directory);
    assert.equal(names.includes(".gsd-delete-manifest.prepared"), false);
    assert.equal(names.includes(".gsd-delete-manifest"), false);
    const temporary = names.find(name => name.startsWith(".gsd-delete-manifest.write-"));
    assert.ok(temporary);
    rmSync(join(directory, temporary));
    write(join(directory, temporary), "later accepted replacement\n");
    handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, null);
    assert.throws(
      () => handle.removeFileViaGuardExact(path, identity, path, true, digest, true),
      /unrecognized deletion manifest temporary was retained/i,
    );
    handle.close();
    assert.equal(readFileSync(join(directory, temporary), "utf8"), "later accepted replacement\n");
  } finally {
    cleanup(base);
  }
});

test("tree deletion excludes children arriving after reviewed consent", () => {
  const base = makeBase("gsd-migrate-tree-snapshot-race-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "remove-tree-snapshot-child");
      assert.throws(
        () => handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true),
        /content changed before deletion manifest commit/i,
      );
      assert.equal(readFileSync(join(base, ".gsd", path, "later-after-consent.md"), "utf8"), "later accepted work\n");
      assert.equal(existsSync(join(base, ".gsd", path, ".gsd-delete-manifest")), false);
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("a torn deletion manifest never extends reviewed tree consent", () => {
  const base = makeBase("gsd-migrate-tree-manifest-consent-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    let handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    setNativeMutationBoundaryFault(handle, "remove-tree-manifest-write-crash");
    assert.throws(
      () => handle.removeFileViaGuardExact(path, identity, path, true, digest, true),
      /manifest write crash/i,
    );
    handle.close();
    write(join(base, ".gsd", path, "later.md"), "later accepted work\n");

    handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, null);
    assert.throws(
      () => handle.removeFileViaGuardExact(path, identity, path, true, digest, true),
      /unrecognized deletion manifest temporary was retained/i,
    );
    handle.close();
    assert.ok(
      readdirSync(join(base, ".gsd", path)).some(name => name.startsWith(".gsd-delete-manifest.write-")),
    );
    assert.equal(readFileSync(join(base, ".gsd", path, "later.md"), "utf8"), "later accepted work\n");
  } finally {
    cleanup(base);
  }
});

test("native deletion acknowledgement waits for complete ledger validation", () => {
  const base = makeBase("gsd-migrate-deletion-ack-schema-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath, "reviewed.md"), "reviewed\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(evidencePath);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    setNativeMutationBoundaryFault(handle, "remove-tree-crash");
    assert.throws(
      () => handle.removeFileViaGuardExact(evidencePath, identity, evidencePath, true, digest, true),
      /simulated tree deletion crash/i,
    );
    setNativeMutationBoundaryFault(handle, null);
    handle.close();
    const ledgerPath = join(base, ".gsd", "migration", "unbound-projection-evidence.json");
    write(ledgerPath, `${JSON.stringify([{
      evidencePath, evidenceIdentity: identity, kind: "quarantine", logicalPath: "notes/result",
      scope: "tree", transition: "retained", nativeDeletionAckPending: true,
    }, {
      evidencePath: "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000002",
      evidenceIdentity: "invalid:identity",
      contentDigest: `sha256:${"0".repeat(64)}`,
      kind: "quarantine",
      logicalPath: "notes/other",
      scope: "tree",
      transition: "retained",
      nativeDeletionAckPending: true,
    }])}\n`);

    assert.throws(
      () => loadUnboundProjectionEvidence(base),
      /deletion acknowledgement is invalid/i,
    );
    assert.equal(existsSync(join(base, ".gsd", evidencePath, ".gsd-delete-manifest")), true);
  } finally {
    cleanup(base);
  }
});

test("native deletion acknowledgement preflights every retained digest", () => {
  const base = makeBase("gsd-migrate-deletion-ack-digest-");
  try {
    const paths = [
      "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001",
      "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000002",
    ];
    for (const evidencePath of paths) {
      write(join(base, ".gsd", evidencePath, "reviewed.md"), "reviewed\n");
    }
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const entries = paths.map((evidencePath) => {
      const evidenceIdentity = handle.pathIdentity(evidencePath);
      const hash = createHash("sha256");
      hash.update("\0directory\0");
      hash.update("reviewed.md\0file\0");
      hash.update("reviewed\n\0");
      setNativeMutationBoundaryFault(handle, "remove-tree-crash");
      assert.throws(
        () => handle.removeFileViaGuardExact(evidencePath, evidenceIdentity, evidencePath, true, `sha256:${hash.digest("hex")}`, true),
        /simulated tree deletion crash/i,
      );
      setNativeMutationBoundaryFault(handle, null);
      return {
        evidencePath,
        evidenceIdentity,
        kind: "quarantine",
        logicalPath: evidencePath.replace(".gsd-projection-remove-", "result-"),
        scope: "tree",
        transition: "retained",
        nativeDeletionAckPending: true,
      };
    });
    handle.close();
    const ledgerPath = join(base, ".gsd", "migration", "unbound-projection-evidence.json");
    write(ledgerPath, `${JSON.stringify([
      { ...entries[0], contentDigest: `sha256:${"0".repeat(64)}` },
      entries[1],
    ])}\n`);

    assert.throws(() => loadUnboundProjectionEvidence(base), /acknowledgement content changed/i);
    for (const path of paths) {
      assert.equal(existsSync(join(base, ".gsd", path, ".gsd-delete-manifest")), true);
    }
  } finally {
    cleanup(base);
  }
});

test("native deletion acknowledgement resumes after manifest removal", () => {
  const base = makeBase("gsd-migrate-deletion-ack-replay-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath, "reviewed.md"), "reviewed\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "quarantine", logicalPath: "notes/result", scope: "tree", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, "remove-tree-retirement-racer");
    handle.close();
    _setUnboundEvidenceAcknowledgementFaultForTest(() => {
      throw new Error("simulated acknowledgement crash");
    });
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /simulated acknowledgement crash/i,
    );
    const [pending] = JSON.parse(readFileSync(
      join(base, ".gsd", "migration", "unbound-projection-evidence.json"),
      "utf8",
    ));
    assert.equal(pending.nativeDeletionAckPending, true);
    assert.equal(existsSync(join(base, ".gsd", pending.evidencePath, ".gsd-delete-manifest")), false);
    const [prepared] = JSON.parse(readFileSync(
      join(base, ".gsd", "migration", "unbound-projection-evidence.json"),
      "utf8",
    ));
    assert.equal(prepared.nativeDeletionAck.phase, "prepared");
    _setUnboundEvidenceAcknowledgementFaultForTest(null);
    const [retained] = loadUnboundProjectionEvidence(base);
    assert.equal(retained.evidencePath, pending.evidencePath);
    assert.equal((JSON.parse(readFileSync(
      join(base, ".gsd", "migration", "unbound-projection-evidence.json"),
      "utf8",
    ))[0] as Record<string, unknown>).nativeDeletionAckPending, undefined);
  } finally {
    _setUnboundEvidenceAcknowledgementFaultForTest(null);
    cleanup(base);
  }
});

test("tree deletion reserves every recovery control namespace", () => {
  const base = makeBase("gsd-migrate-tree-private-collision-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    for (const prefix of [".gsd-delete-private", ".gsd-publication-claim", ".gsd-projection-remove", ".gsd-control-state", ".gsd-exchange-guard", ".gsd-evidence-item", ".gsd-recovery-state", ".gsd-tombstone-item"]) {
      rmSync(join(base, ".gsd", path), { recursive: true, force: true });
      write(join(base, ".gsd", path, prefix, "reviewed.md"), "reviewed\n");
      const root = lstatSync(join(base, ".gsd"), { bigint: true });
      const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
      const identity = handle.pathIdentity(path);
      const hash = createHash("sha256");
      hash.update("\0directory\0");
      hash.update(`${prefix}\0directory\0`);
      hash.update(`${prefix}/reviewed.md\0file\0`);
      hash.update("reviewed\n\0");
      try {
        assert.throws(
          () => handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true),
          /reserved recovery control path/i,
        );
        assert.equal(readFileSync(join(base, ".gsd", path, prefix, "reviewed.md"), "utf8"), "reviewed\n");
      } finally {
        handle.close();
      }
    }
  } finally {
    cleanup(base);
  }
});

test("tree deletion retires reviewed bytes instead of unlinking them", () => {
  const base = makeBase("gsd-migrate-tree-retirement-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true);
      assert.equal(existsSync(join(base, ".gsd", path)), false);
      const tombstone = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-delete-tombstone-"));
      assert.ok(tombstone);
      assert.equal(readFileSync(join(base, ".gsd", "migration", "recovery-evidence", tombstone, "reviewed.md"), "utf8"), "reviewed\n");
      assert.equal(existsSync(join(base, ".gsd", "migration", "recovery-evidence", tombstone, ".gsd-delete-manifest")), true);
      assert.equal(readdirSync(join(base, ".gsd", "notes")).some(name => name.startsWith(".gsd-delete-")), false);
    } finally {
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree retirement preserves a final unmanifested racer", () => {
  const base = makeBase("gsd-migrate-tree-retirement-racer-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "remove-tree-retirement-racer");
      assert.throws(
        () => handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true),
        /retained unexpected occupants/i,
      );
      assert.equal(readFileSync(join(base, ".gsd", path, "later-at-retirement.md"), "utf8"), "later accepted work\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree retirement does not unlink individual child bytes", () => {
  const base = makeBase("gsd-migrate-tree-child-final-proof-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true);
      const tombstone = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-delete-tombstone-"));
      assert.ok(tombstone);
      assert.equal(readFileSync(join(base, ".gsd", "migration", "recovery-evidence", tombstone, "reviewed.md"), "utf8"), "reviewed\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree retirement keeps reviewed child identity in its tombstone", () => {
  const base = makeBase("gsd-migrate-tree-child-final-replacement-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true);
      const tombstone = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-delete-tombstone-"));
      assert.ok(tombstone);
      assert.equal(readFileSync(join(base, ".gsd", "migration", "recovery-evidence", tombstone, "reviewed.md"), "utf8"), "reviewed\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree retirement leaves no child-level deletion claim", () => {
  const base = makeBase("gsd-migrate-tree-delete-racer-");
  try {
    const path = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    try {
      handle.removeFileViaGuardExact(path, identity, path, true, digest, true);
      const tombstone = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-delete-tombstone-"));
      assert.ok(tombstone);
      assert.equal(
        readdirSync(join(base, ".gsd", "migration", "recovery-evidence", tombstone)).some(name => name.startsWith(".gsd-delete-final-")),
        false,
      );
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("retired projection evidence stays outside managed milestone scans", () => {
  const base = makeBase("gsd-migrate-tree-retirement-managed-set-");
  try {
    const path = "milestones/M001/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", path, "M001-PLAN.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(path);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("M001-PLAN.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      handle.removeFileViaGuardExact(path, identity, path, true, `sha256:${hash.digest("hex")}`, true);
    } finally {
      handle.close();
    }
    assert.deepEqual(managedStructuredProjectionPaths(base), []);
    assert.equal(
      readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .some(name => name.startsWith(".gsd-delete-tombstone-")),
      true,
    );
  } finally {
    cleanup(base);
  }
});

test("tree deletion returns a snapshot racer to the public evidence ledger", () => {
  const base = makeBase("gsd-migrate-tree-delete-racer-ledger-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath, "reviewed.md"), "reviewed\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "quarantine", logicalPath: "notes/result", scope: "tree", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    let handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, "remove-tree-retirement-racer");
    handle.close();

    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /retained unexpected occupants/i,
    );
    handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, null);
    handle.close();

    const [retained] = loadUnboundProjectionEvidence(base);
    assert.equal(retained.transition, "retained");
    assert.match(retained.evidencePath, /^notes\/\.gsd-projection-remove-[0-9a-f-]{36}$/u);
    const preserve = previewUnboundProjectionEvidenceResolution(base, retained.evidenceId, "preserve");
    resolveUnboundProjectionEvidence(base, retained.evidenceId, "preserve", preserve.consent);
    assert.equal(readFileSync(join(base, ".gsd", preserve.destinationPath!, "reviewed.md"), "utf8"), "reviewed\n");
    assert.equal(readFileSync(join(base, ".gsd", preserve.destinationPath!, "later-at-retirement.md"), "utf8"), "later accepted work\n");
  } finally {
    cleanup(base);
  }
});

test("tree publication crash before rename never exposes staging", () => {
  const base = makeBase("gsd-migrate-native-publish-crash-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-crash");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${hash.digest("hex")}`),
        /simulated tree publication crash/i,
      );
      assert.equal(existsSync(join(base, ".gsd", destination)), false);
      assert.equal(existsSync(join(base, ".gsd", source)), true);
      setNativeMutationBoundaryFault(handle, null);
      const replayHash = createHash("sha256");
      replayHash.update("\0directory\0");
      replayHash.update("reviewed.md\0file\0");
      replayHash.update("reviewed\n\0");
      handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${replayHash.digest("hex")}`);
      assert.equal(readFileSync(join(base, ".gsd", destination, "reviewed.md"), "utf8"), "reviewed\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree publication resumes a durably identified partial snapshot", () => {
  const base = makeBase("gsd-migrate-native-publish-snapshot-replay-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "one.md"), "one\n");
    write(join(base, ".gsd", source, "two.md"), "two\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    let handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("one.md\0file\0");
    hash.update("one\n\0");
    hash.update("two.md\0file\0");
    hash.update("two\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    setNativeMutationBoundaryFault(handle, "publish-tree-snapshot-copy-crash");
    assert.throws(
      () => handle.restoreQuarantinedTreeExact(source, destination, identity, digest),
      /snapshot copy crash/i,
    );
    handle.close();
    const evidenceRoot = join(base, ".gsd", "migration", "recovery-evidence");
    const claim = readdirSync(evidenceRoot).find(name => name.startsWith(".gsd-publication-claim-"));
    assert.ok(claim);
    assert.equal(existsSync(join(evidenceRoot, claim, "snapshot.preparing.json")), true);

    handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, null);
    handle.restoreQuarantinedTreeExact(source, destination, identity, digest);
    handle.close();
    assert.equal(readFileSync(join(base, ".gsd", destination, "one.md"), "utf8"), "one\n");
    assert.equal(readFileSync(join(base, ".gsd", destination, "two.md"), "utf8"), "two\n");
  } finally {
    cleanup(base);
  }
});

test("tree publication rechecks its private claim at the final rename boundary", () => {
  const base = makeBase("gsd-migrate-native-publish-final-proof-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-final-content");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${hash.digest("hex")}`),
        /private snapshot content changed at publication boundary/i,
      );
      assert.equal(existsSync(join(base, ".gsd", destination)), false);
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree publication preserves a source replacement outside its private claim", () => {
  const base = makeBase("gsd-migrate-native-publish-source-replacement-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-source-replacement");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${hash.digest("hex")}`),
        /source replacement retained/i,
      );
      assert.equal(readFileSync(join(base, ".gsd", destination, "reviewed.md"), "utf8"), "reviewed\n");
      assert.equal(readFileSync(join(base, ".gsd", source, "later.md"), "utf8"), "later accepted replacement\n");
      const evidenceRoot = join(base, ".gsd", "migration", "recovery-evidence");
      const claim = readdirSync(evidenceRoot).find(name => name.startsWith(".gsd-publication-claim-"));
      assert.ok(claim);
      assert.equal(readFileSync(join(evidenceRoot, claim, "retired", "reviewed.md"), "utf8"), "reviewed\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree publication source replacement remains public recovery evidence", () => {
  const base = makeBase("gsd-migrate-publish-source-ledger-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath, "reviewed.md"), "reviewed\n");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath, evidenceIdentity: null, kind: "quarantine", logicalPath: "notes/result", scope: "tree", transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "preserve");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    setNativeMutationBoundaryFault(handle, "publish-tree-source-replacement");
    handle.close();

    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "preserve", preview.consent),
      /source replacement retained/i,
    );
    const retained = loadUnboundProjectionEvidence(base);
    assert.equal(retained.some(entry => entry.transition === "retained"
      && entry.evidencePath.includes(".gsd-projection-remove-")
      && readFileSync(join(base, ".gsd", entry.evidencePath, "later.md"), "utf8") === "later accepted replacement\n"), true);
  } finally {
    const rootPath = join(base, ".gsd");
    if (existsSync(rootPath)) {
      const root = lstatSync(rootPath, { bigint: true });
      const handle = acquireProjectionRootIdentityLock(rootPath, root.dev.toString(), root.ino.toString());
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
    cleanup(base);
  }
});

test("tree publication rejects a replacement after its final snapshot proof", () => {
  const base = makeBase("gsd-migrate-native-publish-final-rename-racer-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-final-rename-racer");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${hash.digest("hex")}`),
        /identity changed at final publication syscall/i,
      );
      assert.equal(existsSync(join(base, ".gsd", destination)), false);
      const evidenceRoot = join(base, ".gsd", "migration", "recovery-evidence");
      const claim = readdirSync(evidenceRoot).find(name => name.startsWith(".gsd-publication-claim-"));
      assert.ok(claim);
      assert.equal(readFileSync(join(evidenceRoot, claim, "snapshot-racer", "reviewed.md"), "utf8"), "reviewed\n");
      assert.equal(readFileSync(join(evidenceRoot, claim, "snapshot", "later.md"), "utf8"), "later accepted replacement\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree publication rejects content changed in its private snapshot", () => {
  const base = makeBase("gsd-migrate-native-publish-final-source-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-final-source-content");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${hash.digest("hex")}`),
        /private snapshot content changed at publication boundary/i,
      );
      assert.equal(existsSync(join(base, ".gsd", destination)), false);
      const claim = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-publication-claim-"));
      assert.ok(claim);
      assert.equal(
        readFileSync(join(base, ".gsd", "migration", "recovery-evidence", claim, "snapshot", "later-at-final-source.md"), "utf8"),
        "later accepted private-snapshot content\n",
      );
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree publication replay retains a bound completion claim", () => {
  const base = makeBase("gsd-migrate-native-publish-post-rename-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-post-rename-crash");
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, digest),
        /post-rename tree publication crash/i,
      );
      assert.equal(readFileSync(join(base, ".gsd", destination, "reviewed.md"), "utf8"), "reviewed\n");
      setNativeMutationBoundaryFault(handle, null);
      handle.restoreQuarantinedTreeExact(source, destination, identity, digest);
      const claim = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-publication-claim-"));
      assert.ok(claim);
      assert.equal(existsSync(join(base, ".gsd", "migration", "recovery-evidence", claim, "published.json")), true);
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("tree publication replay never removes an unbound placeholder", () => {
  const base = makeBase("gsd-migrate-native-publish-placeholder-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    const digest = `sha256:${hash.digest("hex")}`;
    try {
      handle.restoreQuarantinedTreeExact(source, destination, identity, digest);
      const claim = readdirSync(join(base, ".gsd", "migration", "recovery-evidence"))
        .find(name => name.startsWith(".gsd-publication-claim-"));
      assert.ok(claim);
      mkdirSync(join(base, ".gsd", "migration", "recovery-evidence", claim, "payload"));
      assert.throws(
        () => handle.restoreQuarantinedTreeExact(source, destination, identity, digest),
        /unexpected occupants/i,
      );
      assert.equal(existsSync(join(base, ".gsd", "migration", "recovery-evidence", claim, "payload")), true);
    } finally {
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("Windows tree publication fences new descendants through its root rename", { skip: process.platform !== "win32" }, () => {
  const base = makeBase("gsd-migrate-native-publish-descendant-fence-");
  try {
    const source = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const destination = "notes/result";
    write(join(base, ".gsd", source, "reviewed.md"), "reviewed\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const identity = handle.pathIdentity(source);
    const hash = createHash("sha256");
    hash.update("\0directory\0");
    hash.update("reviewed.md\0file\0");
    hash.update("reviewed\n\0");
    try {
      setNativeMutationBoundaryFault(handle, "publish-tree-new-descendant");
      handle.restoreQuarantinedTreeExact(source, destination, identity, `sha256:${hash.digest("hex")}`);
      assert.equal(existsSync(join(base, ".gsd", destination, ".gsd-racing-descendant")), false);
      assert.equal(readFileSync(join(base, ".gsd", destination, "reviewed.md"), "utf8"), "reviewed\n");
    } finally {
      setNativeMutationBoundaryFault(handle, null);
      handle.close();
    }
  } finally {
    cleanup(base);
  }
});

test("managed projection recovery preserves an untrusted journal temporary", () => {
  const base = makeBase("gsd-migrate-journal-untrusted-temp-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const temporaryPath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const journal = join(
      base,
      ".gsd",
      "migration",
      "projection-mutations",
      "00000000-0000-0000-0000-000000000001.json",
    );
    write(join(base, ".gsd", temporaryPath), "untrusted replacement\n");
    write(journal, `${JSON.stringify({
      logicalPath: "notes/result.md",
      operation: "write",
      content: "accepted\n",
      encoding: "utf8",
      temporaryPath,
      temporaryIdentity: null,
      replacementPath: `${temporaryPath}.replaced`,
      replacementIdentity: null,
      quarantinePath: null,
      quarantineIdentity: null,
    })}\n`);

    loadManagedProjectionPaths(base);
    assert.equal(readFileSync(join(base, ".gsd", "notes", "result.md"), "utf8"), "accepted\n");
    assert.equal(readFileSync(join(base, ".gsd", temporaryPath), "utf8"), "untrusted replacement\n");
    assert.equal(existsSync(journal), false);
    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.equal(evidence?.evidencePath, temporaryPath);
    assert.equal(evidence?.kind, "temporary");
    assert.equal(evidence?.logicalPath, "notes/result.md");
    assert.equal(evidence?.scope, "file");
    assert.equal(evidence?.transition, "retained");
    assert.match(evidence?.evidenceId ?? "", /^evidence:sha256:[0-9a-f]{64}$/u);
    assert.match(evidence?.contentDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
    assert.throws(
      () => atomicWriteSync(join(base, ".gsd", "notes", "result.md"), "newer\n"),
      /unresolved recovery evidence/i,
    );
    atomicWriteSync(join(base, ".gsd", "notes", "unrelated.md"), "unrelated\n");
  } finally {
    cleanup(base);
  }
});

test("managed projection recovery preserves a quarantine without persisted identity", () => {
  const base = makeBase("gsd-migrate-journal-untrusted-quarantine-");
  try {
    mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const quarantinePath = "milestones/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    const journal = join(
      base,
      ".gsd",
      "migration",
      "projection-mutations",
      "00000000-0000-0000-0000-000000000001.json",
    );
    write(join(base, ".gsd", quarantinePath, "later.md"), "later accepted work\n");
    write(journal, `${JSON.stringify({
      logicalPath: "milestones/M001",
      operation: "remove-tree",
      content: null,
      encoding: null,
      temporaryPath: null,
      temporaryIdentity: null,
      replacementPath: null,
      replacementIdentity: null,
      quarantinePath,
      quarantineIdentity: null,
    })}\n`);

    loadManagedProjectionPaths(base);
    assert.equal(readFileSync(join(base, ".gsd", quarantinePath, "later.md"), "utf8"), "later accepted work\n");
    assert.equal(existsSync(join(base, ".gsd", "milestones", "M001")), false);
    assert.equal(existsSync(journal), false);
    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.equal(evidence?.evidencePath, quarantinePath);
    assert.match(evidence?.evidenceIdentity ?? "", /^\d+:\d+$/u);
    assert.equal(evidence?.kind, "quarantine");
    assert.equal(evidence?.logicalPath, "milestones/M001");
    assert.equal(evidence?.scope, "tree");
    assert.equal(evidence?.transition, "retained");
    assert.throws(
      () => removeProjectionTreeSync(join(base, ".gsd", "milestones", "M001")),
      /unresolved recovery evidence/i,
    );
    assert.throws(
      () => atomicWriteSync(join(base, ".gsd", "milestones", "M001", "later.md"), "changed\n"),
      /unresolved recovery evidence/i,
    );
    assert.throws(
      () => removeProjectionTreeSync(join(base, ".gsd", "milestones")),
      /unresolved recovery evidence/i,
    );
    assert.throws(
      () => atomicWriteSync(join(base, ".gsd", quarantinePath, "later.md"), "changed\n"),
      /unresolved recovery evidence/i,
    );
    atomicWriteSync(join(base, ".gsd", "notes", "unrelated.md"), "unrelated\n");
  } finally {
    cleanup(base);
  }
});

test("managed removal preserves an unjournaled placeholder and converges", () => {
  const base = makeBase("gsd-migrate-removal-placeholder-crash-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", "notes", "result.md"), "reviewed\n");
    const quarantinePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    const journal = join(
      base,
      ".gsd",
      "migration",
      "projection-mutations",
      "00000000-0000-0000-0000-000000000001.json",
    );
    write(join(base, ".gsd", quarantinePath), "unknown placeholder\n");
    write(journal, `${JSON.stringify({
      logicalPath: "notes/result.md",
      operation: "remove",
      content: null,
      encoding: null,
      temporaryPath: null,
      temporaryIdentity: null,
      replacementPath: null,
      replacementIdentity: null,
      quarantinePath,
      quarantineIdentity: null,
      placeholderIdentity: null,
      exchangeGuardPath: "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001",
    })}\n`);

    loadManagedProjectionPaths(base);

    assert.equal(existsSync(join(base, ".gsd", "notes", "result.md")), false);
    const evidence = loadUnboundProjectionEvidence(base);
    assert.ok(evidence.some(entry => entry.evidencePath === quarantinePath));
    assert.equal(readFileSync(join(base, ".gsd", quarantinePath), "utf8"), "unknown placeholder\n");
    assert.equal(existsSync(journal), false);
  } finally {
    cleanup(base);
  }
});

test("legacy cleanup transfers an unknown placeholder to reviewable evidence", () => {
  const base = makeBase("gsd-migrate-legacy-placeholder-evidence-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    write(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "reviewed\n");
    const logicalPath = "milestones/M001";
    const digest = createHash("sha256").update(logicalPath).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    const quarantine = join(base, ".gsd", "milestones", `.gsd-projection-remove-${id}`);
    mkdirSync(quarantine);
    write(join(quarantine, "unknown.md"), "unknown placeholder\n");

    assert.throws(
      () => removeLegacyProjectionTreeSync(base, join(base, ".gsd", logicalPath)),
      /later authority|unresolved evidence/i,
    );
    const evidence = loadUnboundProjectionEvidence(base);
    assert.ok(evidence.some(entry => entry.evidencePath.endsWith(`.gsd-projection-remove-${id}`)));
  } finally {
    cleanup(base);
  }
});

test("single-file removal rejects a replacement after review", () => {
  const base = makeBase("gsd-migrate-file-remove-race-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const target = join(base, ".gsd", "notes", "result.md");
    write(target, "reviewed\n");
    const mutation = beginManagedProjectionMutation(target, "remove", null, null);
    assert.ok(mutation);
    renameSync(target, `${target}.reviewed`);
    write(target, "later accepted\n");
    try {
      assert.throws(() => applyManagedProjectionMutation(mutation), /identity changed/i);
      assert.equal(readFileSync(target, "utf8"), "later accepted\n");
    } finally {
      retainManagedProjectionMutation(mutation);
    }
  } finally {
    cleanup(base);
  }
});

test("unbound evidence protects its retained physical path", () => {
  const base = makeBase("gsd-migrate-evidence-physical-path-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "unknown\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);

    assert.throws(
      () => removeProjectionTreeSync(join(base, ".gsd", "notes")),
      /unresolved recovery evidence/i,
    );
  } finally {
    cleanup(base);
  }
});

test("unbound evidence resolution is identity and consent bound", () => {
  const base = makeBase("gsd-migrate-evidence-resolution-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "unknown\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);

    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.ok(evidence);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    assert.equal(preview.evidencePath, evidencePath);
    assert.match(preview.consent, /^discard:sha256:/u);
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", "discard:sha256:wrong"),
      /consent/i,
    );
    assert.equal(existsSync(join(base, ".gsd", evidencePath)), true);
    writeFileSync(join(base, ".gsd", evidencePath), "changed after review\n");
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /content|consent/i,
    );
    const changed = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", changed.consent);
    assert.equal(existsSync(join(base, ".gsd", evidencePath)), false);
    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
  } finally {
    cleanup(base);
  }
});

test("destructive evidence consent rejects content changed inside its guard", () => {
  const base = makeBase("gsd-migrate-evidence-guard-content-race-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "reviewed\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.ok(evidence);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");
    _setUnboundEvidenceGuardFaultForTest(() => {
      const guard = readdirSync(join(base, ".gsd", "notes"))
        .find(name => name.startsWith(".gsd-projection-remove-"));
      assert.ok(guard);
      writeFileSync(join(base, ".gsd", "notes", guard), "changed after guard\n");
    });

    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent),
      /changed inside its private guard/i,
    );
  } finally {
    _setUnboundEvidenceGuardFaultForTest(null);
    cleanup(base);
  }
});

test("unbound evidence resolution resumes after bytes move before ledger cleanup", () => {
  const base = makeBase("gsd-migrate-evidence-resolution-crash-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "later accepted work\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.ok(evidence);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "restore");
    _setUnboundEvidenceResolutionFaultForTest(() => { throw new Error("simulated resolution crash"); });
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "restore", preview.consent),
      /resolution crash/,
    );
    _setUnboundEvidenceResolutionFaultForTest(null);

    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
    assert.equal(readFileSync(join(base, ".gsd", "notes", "result.md"), "utf8"), "later accepted work\n");
  } finally {
    _setUnboundEvidenceResolutionFaultForTest(null);
    cleanup(base);
  }
});

test("unbound evidence resolution finishes an already-moved guard", () => {
  const base = makeBase("gsd-migrate-evidence-guard-replay-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    const content = "later accepted work\n";
    const idDigest = createHash("sha256").update(JSON.stringify({
      evidencePath,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
    })).digest("hex");
    const evidenceId = `evidence:sha256:${idDigest}`;
    const guardDigest = createHash("sha256").update(`guard\0${evidenceId}`).digest("hex");
    const guardId = `${guardDigest.slice(0, 8)}-${guardDigest.slice(8, 12)}-${guardDigest.slice(12, 16)}-${guardDigest.slice(16, 20)}-${guardDigest.slice(20, 32)}`;
    const guardPath = `notes/.gsd-projection-remove-${guardId}`;
    write(join(base, ".gsd", guardPath), content);
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(join(base, ".gsd"), root.dev.toString(), root.ino.toString());
    const guardIdentity = handle.pathIdentity(guardPath);
    handle.close();
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidenceId,
      evidencePath,
      evidenceIdentity: guardIdentity,
      contentDigest: digest,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "resolving",
      resolution: {
        action: "discard",
        currentIdentity: guardIdentity,
        contentDigest: digest,
        destinationPath: null,
        guardPath,
        guardIdentity,
        phase: "guarded",
      },
    }], null, 2)}\n`);

    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
    assert.equal(existsSync(join(base, ".gsd", guardPath)), false);
  } finally {
    cleanup(base);
  }
});

test("tree evidence restore rebuilds partial staging before publication", () => {
  const base = makeBase("gsd-migrate-evidence-tree-replay-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath, "one.md"), "one\n");
    write(join(base, ".gsd", evidencePath, "nested", "two.md"), "two\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "quarantine",
      logicalPath: "notes/result",
      scope: "tree",
      transition: "retained",
    }])}\n`);

    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.ok(evidence);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "restore");
    let copied = false;
    _setUnboundEvidenceCopyFaultForTest(() => {
      if (!copied) {
        copied = true;
        throw new Error("simulated partial staging crash");
      }
    });
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "restore", preview.consent),
      /partial staging crash/,
    );
    _setUnboundEvidenceCopyFaultForTest(null);
    assert.equal(existsSync(join(base, ".gsd", "notes", "result")), false);
    loadUnboundProjectionEvidence(base);

    assert.equal(readFileSync(join(base, ".gsd", "notes", "result", "one.md"), "utf8"), "one\n");
    assert.equal(readFileSync(join(base, ".gsd", "notes", "result", "nested", "two.md"), "utf8"), "two\n");
    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
  } finally {
    _setUnboundEvidenceCopyFaultForTest(null);
    cleanup(base);
  }
});

test("unbound evidence can be preserved without destructive consent", () => {
  const base = makeBase("gsd-migrate-evidence-preserve-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "later accepted work\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.ok(evidence);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "preserve");
    resolveUnboundProjectionEvidence(base, evidence.evidenceId, "preserve", preview.consent);

    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
    assert.equal(readFileSync(join(base, ".gsd", preview.destinationPath!), "utf8"), "later accepted work\n");
  } finally {
    cleanup(base);
  }
});

test("native control recovery evidence enters the public resolution ledger", () => {
  const base = makeBase("gsd-migrate-native-evidence-bridge-");
  try {
    const sourcePath = "notes/.gsd-control-result.md.temporary";
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", sourcePath), "later accepted work\n");
    const evidenceStat = lstatSync(join(base, ".gsd", sourcePath), { bigint: true });
    const descriptor = nativeEvidenceDescriptor(
      sourcePath,
      "notes/result.md",
      `${evidenceStat.dev}:${evidenceStat.ino}`,
      "later accepted work\n",
      "interrupted-control-temporary",
    );
    renameSync(join(base, ".gsd", sourcePath), join(base, ".gsd", descriptor.evidencePath));
    const descriptorPath = join(base, ".gsd", "migration", "native-projection-evidence", descriptor.name);
    write(descriptorPath, `${JSON.stringify(descriptor.value)}\n`);

    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.equal(evidence.origin, "native-control");
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "preserve");
    _setUnboundEvidenceResolutionFaultForTest(() => { throw new Error("simulated native evidence resolution crash"); });
    assert.throws(
      () => resolveUnboundProjectionEvidence(base, evidence.evidenceId, "preserve", preview.consent),
      /native evidence resolution crash/,
    );
    _setUnboundEvidenceResolutionFaultForTest(null);

    assert.deepEqual(loadUnboundProjectionEvidence(base), []);
    assert.equal(existsSync(descriptorPath), false);
    assert.equal(readFileSync(join(base, ".gsd", preview.destinationPath!), "utf8"), "later accepted work\n");
  } finally {
    _setUnboundEvidenceResolutionFaultForTest(null);
    cleanup(base);
  }
});

test("native control evidence rejects an unbound descriptor", () => {
  const base = makeBase("gsd-migrate-native-evidence-binding-");
  try {
    const evidencePath = "notes/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    const descriptorPath = join(
      base,
      ".gsd",
      "migration",
      "native-projection-evidence",
      "00000000-0000-0000-0000-000000000001.json",
    );
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", evidencePath), "later accepted work\n");
    write(descriptorPath, `${JSON.stringify({
      contentDigest: `sha256:${createHash("sha256").update("later accepted work\n").digest("hex")}`,
      evidencePath,
      kind: "quarantine",
      logicalPath: "notes/result.md",
      phase: "retained",
      reason: "later-control-target",
      scope: "file",
      version: 1,
    })}\n`);

    assert.throws(() => loadUnboundProjectionEvidence(base), /native projection evidence is invalid/i);
  } finally {
    cleanup(base);
  }
});

test("native control evidence rejects cross-directory control-path mappings", () => {
  const base = makeBase("gsd-migrate-native-evidence-control-path-");
  try {
    const sourcePath = "notes/.gsd-control-result.md.temporary";
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", sourcePath), "unrelated bytes\n");
    const evidenceStat = lstatSync(join(base, ".gsd", sourcePath), { bigint: true });
    const descriptor = nativeEvidenceDescriptor(
      sourcePath,
      "gsd.db",
      `${evidenceStat.dev}:${evidenceStat.ino}`,
      "unrelated bytes\n",
      "later-control-target",
    );
    renameSync(join(base, ".gsd", sourcePath), join(base, ".gsd", descriptor.evidencePath));
    write(
      join(base, ".gsd", "migration", "native-projection-evidence", descriptor.name),
      `${JSON.stringify(descriptor.value)}\n`,
    );

    assert.throws(() => loadUnboundProjectionEvidence(base), /native projection evidence path is invalid/i);
  } finally {
    cleanup(base);
  }
});

test("native control evidence rejects same-directory sibling target remapping", () => {
  const base = makeBase("gsd-migrate-native-evidence-sibling-target-");
  try {
    const sourcePath = ".gsd-control-result.md.temporary";
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    write(join(base, ".gsd", sourcePath), "unrelated bytes\n");
    const evidenceStat = lstatSync(join(base, ".gsd", sourcePath), { bigint: true });
    const descriptor = nativeEvidenceDescriptor(
      sourcePath,
      "active.json",
      `${evidenceStat.dev}:${evidenceStat.ino}`,
      "unrelated bytes\n",
      "interrupted-control-temporary",
    );
    renameSync(join(base, ".gsd", sourcePath), join(base, ".gsd", descriptor.evidencePath));
    write(
      join(base, ".gsd", "migration", "native-projection-evidence", descriptor.name),
      `${JSON.stringify(descriptor.value)}\n`,
    );

    assert.throws(() => loadUnboundProjectionEvidence(base), /native projection evidence path is invalid/i);
  } finally {
    cleanup(base);
  }
});

test("atomic exchange restores a racing replacement", () => {
  const base = makeBase("gsd-migrate-atomic-exchange-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    const source = join(base, ".gsd", "notes", "result.md");
    const displaced = join(base, ".gsd", "notes", "displaced.md");
    const placeholder = join(base, ".gsd", "notes", ".gsd-projection-placeholder");
    write(source, "expected\n");
    write(placeholder, "placeholder\n");
    const root = lstatSync(join(base, ".gsd"), { bigint: true });
    const handle = acquireProjectionRootIdentityLock(
      join(base, ".gsd"),
      root.dev.toString(),
      root.ino.toString(),
    );
    const expectedIdentity = handle.pathIdentity("notes/result.md");
    const placeholderIdentity = handle.pathIdentity("notes/.gsd-projection-placeholder");
    const guardIdentity = handle.prepareFileTemporary(
      "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001",
      Buffer.alloc(0),
    );
    renameSync(source, displaced);
    write(source, "later accepted\n");

    assert.throws(
      () => handle.exchangePaths(
        "notes/result.md",
        "notes/.gsd-projection-placeholder",
        expectedIdentity,
        placeholderIdentity,
        "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001",
        guardIdentity,
      ),
      /identity changed/i,
    );
    assert.equal(readFileSync(source, "utf8"), "later accepted\n");
    assert.equal(readFileSync(placeholder, "utf8"), "placeholder\n");
    handle.close();
  } finally {
    cleanup(base);
  }
});

test("journaled exchange restores a racer captured in its guard", () => {
  const base = makeBase("gsd-migrate-atomic-exchange-recovery-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    const rootPath = join(base, ".gsd");
    const left = join(rootPath, "notes", "result.md");
    const right = join(rootPath, "notes", ".gsd-projection-placeholder");
    const guard = join(rootPath, "notes", ".gsd-projection-exchange-00000000-0000-0000-0000-000000000001");
    write(left, "reviewed\n");
    write(right, "original right\n");
    write(guard, "placeholder\n");
    const root = lstatSync(rootPath, { bigint: true });
    const handle = acquireProjectionRootIdentityLock(rootPath, root.dev.toString(), root.ino.toString());
    const reviewedIdentity = handle.pathIdentity("notes/result.md");
    const placeholderIdentity = handle.pathIdentity("notes/.gsd-projection-placeholder");
    const guardIdentity = handle.pathIdentity("notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001");
    renameSync(right, `${right}.parked`);
    renameSync(guard, right);
    renameSync(`${right}.parked`, guard);
    renameSync(left, `${left}.reviewed`);
    write(left, "later accepted\n");

    assert.throws(
      () => handle.exchangePaths(
        "notes/result.md",
        "notes/.gsd-projection-placeholder",
        reviewedIdentity,
        placeholderIdentity,
        "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001",
        guardIdentity,
      ),
      /identity changed/i,
    );
    assert.equal(readFileSync(left, "utf8"), "later accepted\n");
    assert.equal(readFileSync(right, "utf8"), "placeholder\n");
    assert.equal(readFileSync(guard, "utf8"), "original right\n");
    handle.close();
  } finally {
    cleanup(base);
  }
});

test("journaled exchange resumes from its persisted guard phase", () => {
  const base = makeBase("gsd-migrate-exchange-phase-recovery-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    const rootPath = join(base, ".gsd");
    const left = join(rootPath, "notes", "left.md");
    const right = join(rootPath, "notes", "right.md");
    const guard = join(rootPath, "notes", ".gsd-projection-exchange-00000000-0000-0000-0000-000000000001");
    const parked = join(rootPath, "notes", "parked.md");
    write(left, "left\n");
    write(right, "right\n");
    write(guard, "guard\n");
    const root = lstatSync(rootPath, { bigint: true });
    const handle = acquireProjectionRootIdentityLock(rootPath, root.dev.toString(), root.ino.toString());
    const leftIdentity = handle.pathIdentity("notes/left.md");
    const rightIdentity = handle.pathIdentity("notes/right.md");
    const guardIdentity = handle.pathIdentity("notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001");
    renameSync(right, parked);
    renameSync(guard, right);
    renameSync(parked, guard);

    handle.exchangePaths(
      "notes/left.md",
      "notes/right.md",
      leftIdentity,
      rightIdentity,
      "notes/.gsd-projection-exchange-00000000-0000-0000-0000-000000000001",
      guardIdentity,
    );

    assert.equal(readFileSync(left, "utf8"), "right\n");
    assert.equal(readFileSync(right, "utf8"), "left\n");
    assert.equal(existsSync(guard), false);
    handle.close();
  } finally {
    cleanup(base);
  }
});

test("managed projection directory creation rejects a symlinked ancestor", () => {
  const base = makeBase("gsd-migrate-directory-identity-");
  const outside = makeBase("gsd-migrate-directory-outside-");
  try {
    mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    symlinkSync(outside, join(base, ".gsd", "phases", "redirect"), "dir");

    assert.throws(
      () => createProjectionDirectorySync(join(base, ".gsd", "phases", "redirect", "nested")),
      /outside the GSD root|unsupported symbolic link/i,
    );
    assert.equal(existsSync(join(outside, "nested")), false);
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("first projection directory creation rejects a symlinked ancestor without a database", () => {
  const base = makeBase("gsd-migrate-first-directory-identity-");
  const outside = makeBase("gsd-migrate-first-directory-outside-");
  try {
    mkdirSync(join(base, ".gsd"));
    symlinkSync(outside, join(base, ".gsd", "phases"), "dir");

    assert.throws(
      () => createProjectionDirectorySync(join(base, ".gsd", "phases", "nested")),
      /not a directory|unsupported symbolic link|unsupported node/i,
    );
    assert.equal(existsSync(join(outside, "nested")), false);
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("quarantined tree removal rejects an identity replacement", () => {
  const base = makeBase("gsd-migrate-quarantine-identity-");
  const root = join(base, ".gsd");
  mkdirSync(join(root, "milestones", "M001"), { recursive: true });
  const stat = lstatSync(root, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());
  try {
    const quarantine = "milestones/.gsd-projection-remove-00000000-0000-0000-0000-000000000001";
    const identity = handle.quarantineTree("milestones/M001", quarantine);
    renameSync(join(root, quarantine), join(root, `${quarantine}.original`));
    mkdirSync(join(root, quarantine));
    assert.throws(() => handle.removeQuarantinedTree(quarantine, identity), /identity changed/i);
    assert.equal(existsSync(join(root, quarantine)), true);
    assert.equal(existsSync(join(root, `${quarantine}.original`)), true);
  } finally {
    handle.close();
    cleanup(base);
  }
});

test("recursive removal resumes its exact journaled quarantine", () => {
  const base = makeBase("gsd-migrate-quarantine-recovery-");
  const tree = join(base, ".gsd", "milestones", "M001");
  try {
    mkdirSync(tree, { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    _setManagedProjectionApplyFaultForTest(() => { throw new Error("simulated quarantine crash"); });
    assert.throws(() => removeProjectionTreeSync(tree), /quarantine crash/i);
    _setManagedProjectionApplyFaultForTest(null);
    loadManagedProjectionPaths(base);
    assert.equal(existsSync(tree), false);
    assert.deepEqual(
      readdirSync(join(base, ".gsd", "milestones")).filter(name => name.startsWith(".gsd-projection-remove-")),
      [],
    );
  } finally {
    _setManagedProjectionApplyFaultForTest(null);
    cleanup(base);
  }
});

test("canonical root projections and artifact extensions are managed", () => {
  for (const path of [
    "STATE.md",
    "QUEUE.md",
    "BACKLOG.md",
    "KNOWLEDGE.md",
    "metrics.json",
  ]) {
    assert.equal(classifyGsdLogicalPath(path), "managed", path);
  }
});

test("projection copy rejects a source replaced during exact proof", () => {
  const base = makeBase("gsd-projection-copy-race-");
  try {
    const source = join(base, "source.md");
    const replacement = join(base, "replacement.md");
    const target = join(base, "target.md");
    write(source, "reviewed\n");
    write(replacement, "later\n");
    _setProjectionCopyBoundaryForTest(() => {
      rmSync(source);
      renameSync(replacement, source);
    });
    assert.throws(() => copyProjectionFileSync(source, target, true), /changed during identity proof/i);
    assert.equal(existsSync(target), false);
  } finally {
    _setProjectionCopyBoundaryForTest(null);
    cleanup(base);
  }
});

test("legacy projection cleanup rejects a symlinked orphan", () => {
  const base = makeBase("gsd-legacy-orphan-cleanup-");
  const outside = makeBase("gsd-legacy-orphan-outside-");
  try {
    mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
    write(join(outside, "accepted.md"), "accepted\n");
    symlinkSync(outside, join(base, ".gsd", "milestones", "M003"), "dir");

    assert.throws(
      () => removeLegacyProjectionTreeSync(base, join(base, ".gsd", "milestones", "M003")),
      /symbolic link|unsupported node|projection root|outside/i,
    );
    assert.equal(readFileSync(join(outside, "accepted.md"), "utf8"), "accepted\n");
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("legacy projection cleanup restores an orphan when authority appears", () => {
  const base = makeBase("gsd-legacy-orphan-authority-race-");
  const orphan = join(base, ".gsd", "milestones", "M003");
  try {
    mkdirSync(join(orphan, "slices"), { recursive: true });
    _setLegacyProjectionCleanupBoundaryForTest(() => write(join(base, ".gsd", "gsd.db"), "authority"));
    assert.throws(() => removeLegacyProjectionTreeSync(base, orphan), /authority appeared/i);
    assert.equal(existsSync(orphan), true);
  } finally {
    _setLegacyProjectionCleanupBoundaryForTest(null);
    cleanup(base);
  }
});

test("managed legacy tree removal routes through authority-aware cleanup", (t) => {
  const base = makeBase("gsd-managed-legacy-cleanup-route-");
  const orphan = join(base, ".gsd", "milestones", "M003");
  t.after(() => {
    _setLegacyProjectionCleanupBoundaryForTest(null);
    cleanup(base);
  });
  mkdirSync(join(orphan, "slices"), { recursive: true });
  _setLegacyProjectionCleanupBoundaryForTest(() => write(join(base, ".gsd", "gsd.db"), "authority"));
  assert.throws(() => removeProjectionTreeSync(orphan), /authority appeared/i);
  assert.equal(existsSync(orphan), true);
});

test("legacy projection cleanup resumes after an interrupted exchange", () => {
  const base = makeBase("gsd-legacy-orphan-cleanup-replay-");
  const orphan = join(base, ".gsd", "milestones", "M003");
  try {
    mkdirSync(orphan, { recursive: true });
    _setLegacyProjectionCleanupBoundaryForTest(() => { throw new Error("simulated cleanup crash"); });
    assert.throws(() => removeLegacyProjectionTreeSync(base, orphan), /cleanup crash/);
    _setLegacyProjectionCleanupBoundaryForTest(null);

    removeLegacyProjectionTreeSync(base, orphan);
    assert.equal(existsSync(orphan), false);
    assert.deepEqual(
      readdirSync(join(base, ".gsd", "milestones")).filter(name => name.startsWith(".gsd-projection-")),
      [],
    );
  } finally {
    _setLegacyProjectionCleanupBoundaryForTest(null);
    cleanup(base);
  }
});

test("legacy projection cleanup resumes an exchange completed before placeholder removal", () => {
  const base = makeBase("gsd-legacy-orphan-exchange-replay-");
  const orphan = join(base, ".gsd", "milestones", "M003");
  const journalRoot = join(base, ".gsd", "migration", "projection-mutations");
  try {
    mkdirSync(orphan, { recursive: true });
    _setLegacyProjectionCleanupExchangeFaultForTest(() => { throw new Error("simulated cleanup crash"); });
    assert.throws(() => removeLegacyProjectionTreeSync(base, orphan), /cleanup crash/);
    _setLegacyProjectionCleanupExchangeFaultForTest(null);

    // The quarantine exchange completed and was journaled, but the process
    // died before the placeholder was removed from the orphan path. Recovery
    // must recognize the completed exchange instead of re-issuing it: the
    // Windows native exchange only accepts a completed state when no guard
    // exists, so a re-issued exchange wedges the journal there permanently.
    removeLegacyProjectionTreeSync(base, orphan);
    assert.equal(existsSync(orphan), false);
    assert.deepEqual(
      readdirSync(join(base, ".gsd", "milestones")).filter(name => name.startsWith(".gsd-projection-")),
      [],
    );
    assert.deepEqual(
      (existsSync(journalRoot) ? readdirSync(journalRoot) : []).filter(name => name.endsWith(".json")),
      [],
    );
  } finally {
    _setLegacyProjectionCleanupExchangeFaultForTest(null);
    cleanup(base);
  }
});

test("legacy projection cleanup retains evidence when the quarantine identity changes across the exchange boundary", () => {
  const base = makeBase("gsd-legacy-orphan-exchange-evidence-");
  const orphan = join(base, ".gsd", "milestones", "M003");
  const journalRoot = join(base, ".gsd", "migration", "projection-mutations");
  try {
    mkdirSync(orphan, { recursive: true });
    _setLegacyProjectionCleanupExchangeFaultForTest(() => { throw new Error("simulated cleanup crash"); });
    assert.throws(() => removeLegacyProjectionTreeSync(base, orphan), /cleanup crash/);
    _setLegacyProjectionCleanupExchangeFaultForTest(null);

    // The exchange completed and journaled: the orphan now holds the empty
    // placeholder and the quarantine holds the original tree. Replace the
    // quarantine so its identity no longer matches the journal.
    const quarantine = readdirSync(join(base, ".gsd", "milestones"))
      .find(name => name.startsWith(".gsd-projection-remove-"));
    assert.ok(quarantine);
    const quarantinePath = join(base, ".gsd", "milestones", quarantine);
    renameSync(quarantinePath, `${quarantinePath}.superseded`);
    mkdirSync(quarantinePath, { recursive: true });

    // Recovery must retain reviewable evidence and close the journal instead
    // of re-issuing an exchange against a stale identity, which would wedge
    // the journal and fail every later projection operation.
    assert.throws(
      () => removeLegacyProjectionTreeSync(base, orphan),
      /recovery evidence retained/i,
    );
    assert.deepEqual(
      (existsSync(journalRoot) ? readdirSync(journalRoot) : []).filter(name => name.endsWith(".json")),
      [],
    );
    assert.equal(loadUnboundProjectionEvidence(base).length, 2);
  } finally {
    _setLegacyProjectionCleanupExchangeFaultForTest(null);
    cleanup(base);
  }
});

test("legacy projection cleanup honors the publication mutation claim", () => {
  const base = makeBase("gsd-legacy-orphan-cleanup-fence-");
  const orphan = join(base, ".gsd", "milestones", "M003");
  try {
    mkdirSync(orphan, { recursive: true });
    const release = claimProjectionMaintenance(join(base, ".gsd", "gsd.db"));
    try {
      assert.throws(() => removeLegacyProjectionTreeSync(base, orphan), /maintenance|fenced/i);
      assert.equal(existsSync(orphan), true);
    } finally {
      release();
    }
    removeLegacyProjectionTreeSync(base, orphan);
    assert.equal(existsSync(orphan), false);
  } finally {
    cleanup(base);
  }
});

test("legacy projection cleanup refuses targets with unresolved recovery evidence", () => {
  const base = makeBase("gsd-legacy-orphan-cleanup-evidence-");
  const notes = join(base, ".gsd", "notes");
  try {
    mkdirSync(notes, { recursive: true });
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "unknown\n");
    write(join(base, ".gsd", "migration", "unbound-projection-evidence.json"), `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);

    assert.throws(
      () => removeLegacyProjectionTreeSync(base, notes),
      /unresolved recovery evidence/i,
    );
    assert.equal(existsSync(join(base, ".gsd", evidencePath)), true);
  } finally {
    cleanup(base);
  }
});

test("unbound evidence resolution preserves ledger entries recorded at the resolution boundary", () => {
  const base = makeBase("gsd-migrate-evidence-resolution-ledger-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const evidencePath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000001";
    write(join(base, ".gsd", evidencePath), "unknown\n");
    const ledgerPath = join(base, ".gsd", "migration", "unbound-projection-evidence.json");
    write(ledgerPath, `${JSON.stringify([{
      evidencePath,
      evidenceIdentity: null,
      kind: "temporary",
      logicalPath: "notes/result.md",
      scope: "file",
      transition: "retained",
    }])}\n`);
    const [evidence] = loadUnboundProjectionEvidence(base);
    assert.ok(evidence);
    const preview = previewUnboundProjectionEvidenceResolution(base, evidence.evidenceId, "discard");

    // Simulate a ledger update landing between the resolution body and the
    // final ledger write (e.g. evidence recorded by a nested recovery step):
    // the final write must re-read instead of persisting a stale snapshot.
    const concurrentPath = "notes/.gsd-projection-tmp-00000000-0000-0000-0000-000000000002";
    write(join(base, ".gsd", concurrentPath), "concurrent\n");
    _setUnboundEvidenceResolutionFaultForTest(() => {
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown[];
      ledger.push({
        evidencePath: concurrentPath,
        evidenceIdentity: null,
        kind: "temporary",
        logicalPath: "notes/concurrent.md",
        scope: "file",
        transition: "retained",
      });
      writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
    });

    resolveUnboundProjectionEvidence(base, evidence.evidenceId, "discard", preview.consent);
    _setUnboundEvidenceResolutionFaultForTest(null);

    const remaining = loadUnboundProjectionEvidence(base);
    assert.deepEqual(remaining.map(entry => entry.logicalPath), ["notes/concurrent.md"]);
  } finally {
    _setUnboundEvidenceResolutionFaultForTest(null);
    cleanup(base);
  }
});

test("managed projection recovery skips foreign files in the mutation journal", () => {
  const base = makeBase("gsd-migrate-managed-foreign-journal-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const journalRoot = join(base, ".gsd", "migration", "projection-mutations");
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(join(journalRoot, ".DS_Store"), "foreign");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      loadManagedProjectionPaths(base);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some(message => /foreign|skipping/i.test(message)));
    assert.equal(existsSync(join(journalRoot, ".DS_Store")), true);

    writeFileSync(join(journalRoot, "broken.json"), "not json");
    assert.throws(() => loadManagedProjectionPaths(base), /json|invalid/i);
  } finally {
    cleanup(base);
  }
});

test("projection identity existence checks reject FIFOs without opening them", { skip: process.platform === "win32" }, () => {
  const base = makeBase("gsd-migrate-managed-fifo-");
  const root = join(base, ".gsd");
  mkdirSync(root, { recursive: true });
  const stat = lstatSync(root, { bigint: true });
  const handle = acquireProjectionRootIdentityLock(root, stat.dev.toString(), stat.ino.toString());
  try {
    execFileSync("mkfifo", [join(root, "blocked")]);
    assert.throws(() => handle.pathExists("blocked"), /unsupported node/i);
  } finally {
    handle.close();
    cleanup(base);
  }
});

test("projection journal recovery rejects a replaced symlink ancestor", () => {
  const base = makeBase("gsd-migrate-journal-symlink-");
  const outside = makeBase("gsd-migrate-journal-outside-");
  try {
    mkdirSync(join(base, ".gsd", "notes"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    const path = join(base, ".gsd", "notes", "recovery.md");

    _setManagedMutationBoundaryForTest((boundary) => {
      if (boundary === "before-write") return;
      throw new Error("simulated stale journal");
    });
    assert.throws(() => atomicWriteSync(path, "retained\n"), /simulated stale journal/);
    _setManagedMutationBoundaryForTest(null);
    renameSync(join(base, ".gsd", "notes"), join(base, ".gsd", "notes-original"));
    symlinkSync(outside, join(base, ".gsd", "notes"), "dir");

    assert.throws(() => loadManagedProjectionPaths(base), /symbolic link|projection root/i);
    assert.equal(existsSync(join(outside, "recovery.md")), false);
  } finally {
    _setManagedMutationBoundaryForTest(null);
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("migration publication resumes an interrupted retained copy", async () => {
  const base = makeBase("gsd-migrate-partial-publication-");
  const stagedRoot = makeBase("gsd-migrate-partial-stage-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const staged = await writeGSDDirectory(projectFixture(), stagedRoot);
    const input = {
      sourcePath: planning,
      targetRoot: base,
      requestHash: migrationPublicationRequestHash(planning, join(stagedRoot, ".gsd")),
      startedAt: new Date().toISOString(),
      preview: generatePreview(projectFixture()),
      backup: { backupPath: null, hadExistingGsd: true, targetGsdPath: join(base, ".gsd") },
      stagedGsd: join(stagedRoot, ".gsd"),
      staged,
      expectedTargets: [] as string[],
      projectionRootIdentity: proveMigrationProjectionRoot(base),
    };
    let interrupted = false;
    _setProjectionMutationBoundaryForTest((boundary) => {
      if (boundary === "after-copy" && !interrupted) {
        interrupted = true;
        throw new Error("simulated retained-copy interruption");
      }
    });
    assert.throws(() => prepareMigrationPublication(input), /retained-copy interruption/);
    _setProjectionMutationBoundaryForTest(null);

    const publication = prepareMigrationPublication(input);
    assert.equal(publication.requestHash, input.requestHash);
    assert.ok(publication.projectionHashes.length > 0);

    const unexpectedDirectory = join(
      base,
      ".gsd",
      "migration-applications",
      publication.publicationKey,
      "projection",
      "unexpected-empty-directory",
    );
    mkdirSync(unexpectedDirectory);
    assert.throws(
      () => findMigrationPublication(planning, base, input.requestHash, input.projectionRootIdentity),
      /manifest is invalid/i,
    );
    rmSync(unexpectedDirectory, { recursive: true });

    const unexpected = join(
      base,
      ".gsd",
      "migration-applications",
      publication.publicationKey,
      "projection",
      "unexpected.md",
    );
    write(unexpected, "unreviewed retained evidence\n");
    assert.throws(
      () => findMigrationPublication(planning, base, input.requestHash, input.projectionRootIdentity),
      /manifest is invalid/i,
    );
  } finally {
    _setProjectionMutationBoundaryForTest(null);
    cleanup(base);
    rmSync(stagedRoot, { recursive: true, force: true });
  }
});

test("migration publication binds copied bytes to the reviewed request hash", async () => {
  const base = makeBase("gsd-migrate-request-race-");
  const stagedRoot = makeBase("gsd-migrate-request-race-stage-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const staged = await writeGSDDirectory(projectFixture(), stagedRoot);
    const stagedGsd = join(stagedRoot, ".gsd");
    const requestHash = migrationPublicationRequestHash(planning, stagedGsd);
    let mutated = false;
    _setProjectionMutationBoundaryForTest((boundary) => {
      if (boundary === "before-copy" && !mutated) {
        mutated = true;
        write(join(stagedGsd, "PROJECT.md"), "# Unreviewed replacement\n");
      }
    });

    assert.throws(() => prepareMigrationPublication({
      sourcePath: planning,
      targetRoot: base,
      requestHash,
      startedAt: new Date().toISOString(),
      preview: generatePreview(projectFixture()),
      backup: { backupPath: null, hadExistingGsd: true, targetGsdPath: join(base, ".gsd") },
      stagedGsd,
      staged,
      expectedTargets: [],
      projectionRootIdentity: proveMigrationProjectionRoot(base),
    }), /request hash|reviewed evidence/i);
  } finally {
    _setProjectionMutationBoundaryForTest(null);
    cleanup(base);
    rmSync(stagedRoot, { recursive: true, force: true });
  }
});

test("migration projection identity is lossless across native boundaries", () => {
  const base = makeBase("gsd-migrate-lossless-identity-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const identity = proveMigrationProjectionRoot(base);
    assert.equal(typeof identity.targetDevice, "string");
    assert.equal(typeof identity.targetInode, "string");
    assert.equal(typeof identity.rootDevice, "string");
    assert.equal(typeof identity.rootInode, "string");
  } finally {
    cleanup(base);
  }
});

test("projection mutation gate follows helper calls across managed paths", () => {
  const fixture = makeBase("gsd-projection-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'function gsdRoot(base: string): string { return join(base, ".gsd"); }',
      'function writeIfMissing(path: string): void { writeFileSync(path, "unsafe"); }',
      'export function publish(base: string): void {',
      '  writeIfMissing(join(gsdRoot(base), "research", "BLOCKER.md"));',
      '}',
      '',
    ].join("\n"));

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("projection mutation gate follows generic GSD root dataflow", () => {
  const fixture = makeBase("gsd-projection-generic-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'function directory(base: string): string { return resolve(base, ".gsd"); }',
      'function persist(path: string): void { writeFileSync(path, "unsafe"); }',
      'export function publish(base: string): void {',
      '  const root = directory(base);',
      '  persist(resolve(root, "last-snapshot.md"));',
      '}',
      '',
    ].join("\n"));

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("projection mutation gate covers stream filesystem mutators", () => {
  const fixture = makeBase("gsd-projection-stream-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { createWriteStream } from "node:fs";',
      'import { resolve } from "node:path";',
      'const root = (base: string): string => resolve(base, ".gsd");',
      'export function publish(base: string): void {',
      '  createWriteStream(resolve(root(base), "reports", "latest.json"));',
      '}',
      '',
    ].join("\n"));

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("projection mutation gate rejects module-scope managed writes", () => {
  const fixture = makeBase("gsd-projection-module-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'writeFileSync(resolve(process.cwd(), ".gsd", "STATE.md"), "unsafe");',
      '',
    ].join("\n"));
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("projection mutation gate resolves typed filesystem mutator objects", () => {
  const fixture = makeBase("gsd-projection-object-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { rmSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'type FsOps = { rmSync: typeof rmSync };',
      'const fsOps: FsOps = { rmSync };',
      'export function cleanup(base: string): void {',
      '  fsOps.rmSync(resolve(base, ".gsd", "milestones"), { recursive: true });',
      '}',
      '',
    ].join("\n"));
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("projection mutation gate flags literal-joined .gsd paths", () => {
  const fixture = makeBase("gsd-projection-literal-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'export function publish(base: string): void {',
      '  writeFileSync(join(base, ".gsd/milestones/M001/M001-ROADMAP.md"), "unsafe");',
      '}',
      '',
    ].join("\n"));

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("projection mutation gate flags .gsd-headed template literal paths", () => {
  const fixture = makeBase("gsd-projection-template-gate-");
  try {
    write(join(fixture, "unsafe.ts"), [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'export function publish(base: string, milestoneId: string): void {',
      '  writeFileSync(join(base, `.gsd/milestones/${milestoneId}/M001-ROADMAP.md`), "unsafe");',
      '}',
      '',
    ].join("\n"));

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "check-gsd-projection-mutations.mjs"), fixture],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe\.ts:\d+/);
  } finally {
    cleanup(fixture);
  }
});

test("milestone projection mutations honor the publication claim", () => {
  const base = makeBase("gsd-migrate-milestone-actions-fence-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    write(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Milestone\n");
    const databasePath = join(base, ".gsd", "gsd.db");
    assert.equal(openDatabase(databasePath), true);
    insertMilestone({ id: "M001", title: "Milestone", status: "pending" });
    const release = claimProjectionMaintenance(databasePath);
    try {
      assert.throws(() => parkMilestone(base, "M001", "hold"), /maintenance|fenced/i);
    } finally {
      release();
    }
    assert.equal(existsSync(join(base, ".gsd", "milestones", "M001", "M001-PARKED.md")), false);
  } finally {
    cleanup(base);
  }
});

test("migration backup rejects a symlinked destination root", () => {
  const base = makeBase("gsd-migrate-backup-symlink-");
  const outside = makeBase("gsd-migrate-backup-outside-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    write(join(base, ".gsd", "PROJECT.md"), "# Project\n");
    symlinkSync(outside, join(base, ".gsd-backups"), "dir");

    assert.throws(() => prepareMigrationTarget(base), /backup|symbolic link|projection root/i);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("guided queue projection rewrites honor the publication claim", () => {
  const base = makeBase("gsd-migrate-guided-queue-fence-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    const databasePath = join(base, ".gsd", "gsd.db");
    assert.equal(openDatabase(databasePath), true);
    const contextPath = join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md");
    const original = "---\ndepends_on: [M002]\n---\n# Context\n";
    write(contextPath, original);
    const release = claimProjectionMaintenance(databasePath);
    try {
      assert.throws(
        () => _removeDependsOnFromContextFilesForTest(base, [{ milestone: "M001", dep: "M002" }]),
        /maintenance|fenced/i,
      );
      assert.equal(readFileSync(contextPath, "utf8"), original);
    } finally {
      release();
    }
  } finally {
    cleanup(base);
  }
});

test("workflow tool projection removals honor the publication claim", () => {
  const base = makeBase("gsd-migrate-workflow-tool-fence-");
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    const databasePath = join(base, ".gsd", "gsd.db");
    assert.equal(openDatabase(databasePath), true);
    const draftPath = join(base, ".gsd", "milestones", "M001", "M001-CONTEXT-DRAFT.md");
    write(draftPath, "draft\n");
    const release = claimProjectionMaintenance(databasePath);
    try {
      assert.throws(() => _removeContextDraftProjectionForTest(draftPath), /maintenance|fenced/i);
      assert.equal(readFileSync(draftPath, "utf8"), "draft\n");
    } finally {
      release();
    }
  } finally {
    cleanup(base);
  }
});

test("operation-fenced cleanup honors the publication mutation claim", () => {
  const base = makeBase("gsd-migrate-cleanup-fence-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const databasePath = join(base, ".gsd", "gsd.db");
    assert.equal(openDatabase(databasePath), true);
    const path = join(base, ".gsd", "notes", "owned.md");
    write(path, "owned\n");
    const release = claimProjectionMaintenance(databasePath);
    try {
      assert.throws(() => removeProjectionIfCurrent({
        artifactPath: path,
        operationId: "operation-1",
        isCurrent: () => true,
      }), /maintenance|fenced/i);
      assert.equal(readFileSync(path, "utf8"), "owned\n");
    } finally {
      release();
    }
  } finally {
    cleanup(base);
  }
});

test("maintenance claim fences projection writes through a symlinked project alias", async () => {
  const base = makeBase("gsd-migrate-maintenance-real-");
  const aliasRoot = makeBase("gsd-migrate-maintenance-alias-");
  const alias = join(aliasRoot, "project");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    symlinkSync(base, alias, "dir");
    assert.equal(openDatabase(join(alias, ".gsd", "gsd.db")), true);
    let checkOutside!: () => void;
    const check = new Promise<void>((resolve) => { checkOutside = resolve; });
    const outside = new Promise<void>((resolve, reject) => {
      setImmediate(async () => {
        await check;
        try {
          assert.throws(
            () => atomicWriteSync(join(base, ".gsd", "blocked.md"), "blocked\n"),
            /maintenance|fenced/i,
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await withDatabaseMaintenanceClaim(async () => {
      checkOutside();
      await outside;
    });
  } finally {
    cleanup(base);
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});

test("direct renderer removals honor the maintenance publication fence", async () => {
  const base = makeBase("gsd-migrate-renderer-fence-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "", status: "pending" });
    const roadmap = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    write(roadmap, "stale\n");
    let runOutside!: () => void;
    const start = new Promise<void>((resolve) => { runOutside = resolve; });
    const outside = new Promise<void>((resolve, reject) => {
      setImmediate(async () => {
        await start;
        try {
          await assert.rejects(() => renderRoadmapFromDb(base, "M001"), /maintenance|fenced/i);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await withDatabaseMaintenanceClaim(async () => {
      runOutside();
      await outside;
    });
    assert.equal(readFileSync(roadmap, "utf8"), "stale\n");
  } finally {
    cleanup(base);
  }
});

test("migration publication requires supported Windows directory durability", async () => {
  const base = makeBase("gsd-migrate-publication-windows-sync-");
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const originalOpen = fs.openSync;
  try {
    const outputPath = join(base, ".gsd", "migration", "manifest.json");
    write(outputPath, "{}\n");
    const identity = proveMigrationProjectionRoot(base);
    const probe = acquireProjectionRootIdentityLock(identity.rootPath, identity.rootDevice!, identity.rootInode!);
    const prototype = Object.getPrototypeOf(probe) as {
      syncDirectory(this: typeof probe, path: string): void;
    };
    probe.close();
    const originalSyncDirectory = prototype.syncDirectory;
    try {
      _setMigrationPublicationPlatformForTest("win32");
      fs.openSync = ((path, flags, mode) => {
        if (existsSync(path) && lstatSync(path).isDirectory()) {
          const error = new Error("Windows does not open directories for fsync") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        return originalOpen(path, flags, mode);
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      const synchronized: string[] = [];
      prototype.syncDirectory = function (path) {
        synchronized.push(path);
        originalSyncDirectory.call(this, path);
      };
      const hashes = syncMigrationPublicationOutputs({ targetRoot: base } as never, [outputPath]);
      assert.equal(hashes.length, 1);
      assert.ok(synchronized.includes("migration"));
      prototype.syncDirectory = () => { throw new Error("directory durability unavailable"); };
      assert.throws(() => syncMigrationPublicationOutputs({ targetRoot: base } as never, [outputPath]), /directory durability/);
    } finally {
      prototype.syncDirectory = originalSyncDirectory;
    }
  } finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
    _setMigrationPublicationPlatformForTest(null);
    _setMigrationDirectorySyncForTest(null);
    cleanup(base);
  }
});

test("migration publication output sync walks directory outputs through the locked handle", () => {
  // Regression: realpath(base) === base here (the Linux prod/CI shape), so the
  // legacy archive directory and the realpath'd target root coincide. A
  // directory output (e.g. .gsd/migration/legacy/planning) must be
  // kind-checked and walked — never readFile'd as a file, which threw after
  // the Import Application committed and made replay fail identically.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-publication-dir-output-")));
  try {
    assert.equal(realpathSync(base), base, "test requires a symlink-free target root");
    const archiveDir = join(base, ".gsd", "migration", "legacy", "planning");
    write(join(archiveDir, "ROADMAP.md"), "# legacy\n");
    write(join(archiveDir, "phases", "01", "PLAN.md"), "plan\n");
    const hashes = syncMigrationPublicationOutputs({ targetRoot: base } as never, [archiveDir]);
    const byPath = new Map(hashes.map((entry) => [entry.logicalPath, entry.sha256]));
    assert.equal(
      byPath.get(".gsd/migration/legacy/planning/ROADMAP.md"),
      `sha256:${createHash("sha256").update("# legacy\n").digest("hex")}`,
    );
    assert.equal(
      byPath.get(".gsd/migration/legacy/planning/phases/01/PLAN.md"),
      `sha256:${createHash("sha256").update("plan\n").digest("hex")}`,
    );
    assert.equal(byPath.get(".gsd/migration/legacy/planning/phases"), "directory");
  } finally {
    cleanup(base);
  }
});

test("migration staging sweep removes only stale staging trees", () => {
  const base = makeBase("gsd-migrate-staging-sweep-");
  try {
    const stale = join(base, ".gsd-migrate-stage-stale");
    const fresh = join(base, ".gsd-migrate-stage-fresh");
    mkdirSync(stale);
    write(join(stale, "retained", "evidence.md"), "leaked\n");
    mkdirSync(fresh);
    write(join(base, ".gsd-migrate-stage-file"), "not a staging tree\n");
    write(join(base, "keep.me"), "unrelated\n");

    sweepStaleMigrationStaging(base);
    assert.equal(existsSync(stale), true, "fresh staging trees are never swept");
    assert.equal(existsSync(fresh), true, "fresh staging trees are never swept");

    sweepStaleMigrationStaging(base, Date.now() + 2 * 60 * 60 * 1000);
    assert.equal(existsSync(stale), false, "stale staging tree swept");
    assert.equal(existsSync(fresh), false, "stale staging tree swept");
    assert.equal(existsSync(join(base, ".gsd-migrate-stage-file")), true, "non-directory staging names are left alone");
    assert.equal(existsSync(join(base, "keep.me")), true, "unrelated entries are left alone");
  } finally {
    cleanup(base);
  }
});

test("migration publication pruning keeps replay evidence and collects crash remnants", () => {
  const base = makeBase("gsd-migrate-publication-prune-");
  const dayMs = 24 * 60 * 60 * 1000;
  const manifest = (phase: string, completedAt: string | null): string => (
    `${JSON.stringify({ record: { schemaVersion: 2, phase, completedAt }, payloadHash: "unused" }, null, 2)}\n`
  );
  try {
    const root = join(base, ".gsd", "migration-applications");
    // Completed > 30 days: pruned with its intent file.
    write(join(root, "olddone", "manifest.json"), manifest("complete", new Date(Date.now() - 40 * dayMs).toISOString()));
    write(join(root, "olddone", "projection", "PROJECT.md"), "retained\n");
    write(join(root, "olddone.intent.json"), "{}\n");
    // Completed recently: kept.
    write(join(root, "recentdone", "manifest.json"), manifest("complete", new Date(Date.now() - 2 * dayMs).toISOString()));
    // Pending publications are replay evidence: kept at any age.
    write(join(root, "pending", "manifest.json"), manifest("projected", null));
    // Unreadable manifests are kept — never delete what cannot be classified.
    write(join(root, "broken", "manifest.json"), "not json\n");
    // Crash remnants: intent without manifest, and a manifestless retained tree.
    write(join(root, "orphan.intent.json"), "{}\n");
    write(join(root, "orphan", "projection", "PARTIAL.md"), "partial\n");
    write(join(root, "partial", "projection", "PARTIAL.md"), "partial\n");

    pruneMigrationPublications(base);

    assert.equal(existsSync(join(root, "olddone")), false, "expired completed publication pruned");
    assert.equal(existsSync(join(root, "olddone.intent.json")), false, "expired completed intent pruned");
    assert.equal(existsSync(join(root, "recentdone", "manifest.json")), true, "recent completed publication kept");
    assert.equal(existsSync(join(root, "pending", "manifest.json")), true, "pending publication kept");
    assert.equal(existsSync(join(root, "broken", "manifest.json")), true, "unclassifiable manifest kept");
    assert.equal(existsSync(join(root, "orphan.intent.json")), true, "fresh intent remnant kept (may be in-flight)");
    assert.equal(existsSync(join(root, "partial")), true, "fresh partial tree kept (may be in-flight)");

    pruneMigrationPublications(base, undefined, Date.now() + 90 * dayMs);

    assert.equal(existsSync(join(root, "orphan.intent.json")), false, "stale intent remnant swept");
    assert.equal(existsSync(join(root, "orphan")), false, "partial tree named by a swept intent removed");
    assert.equal(existsSync(join(root, "partial")), false, "stale manifestless retained tree swept");
    assert.equal(existsSync(join(root, "recentdone", "manifest.json")), false, "completed publication pruned once expired");
    assert.equal(existsSync(join(root, "pending", "manifest.json")), true, "pending publication kept at any age");
    assert.equal(existsSync(join(root, "broken", "manifest.json")), true, "unclassifiable manifest kept at any age");
  } finally {
    cleanup(base);
  }
});

test("migration publication routes an advanced head through Forward Repair", async () => {
  const base = makeBase("gsd-migrate-publication-forward-repair-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);

    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    recordAcceptedOperation("migration-review.publication-later-work", () => {
      insertMilestone({ id: "M900", title: "Later accepted work", status: "active" });
      insertArtifact({
        path: ".gsd/notes/later.md",
        artifact_type: "note",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "later canonical artifact\n",
      });
    });
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });
    const staleManaged = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md");
    write(staleManaged, "stale retained projection\n");

    const replay = await executeMigrationWrite(planning, base, project, preview);
    assert.ok(getMilestone("M900"), "later accepted work is preserved");
    assert.ok(getMilestone("M001"), "migration target is retained");
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"],
      1,
    );
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"],
      1,
    );
    assert.equal(replay.verification.db.milestones, 2);
    assert.match(readFileSync(join(base, ".gsd", "ROADMAP.md"), "utf8"), /M900: Later accepted work/);
    assert.equal(readFileSync(join(base, ".gsd", "notes", "later.md"), "utf8"), "later canonical artifact\n");
    assert.equal(existsSync(staleManaged), false, "Forward Repair removes proven stale managed files");
  } finally {
    cleanup(base);
  }
});

test("Forward Repair rejects unexpected managed projection files", async (t) => {
  const base = makeBase("gsd-migrate-unexpected-projection-");
  t.after(() => cleanup(base));
  const planning = createPlanningSource(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
  const project = projectFixture();
  const preview = generatePreview(project);
  await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
  recordAcceptedOperation("migration-review.unexpected-projection", () => {
    insertMilestone({ id: "M900", title: "Later accepted work", status: "active" });
  });
  rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });
  write(join(base, ".gsd", "milestones", "M777", "M777-ROADMAP.md"), "unexpected\n");

  await assert.rejects(
    () => executeMigrationWrite(planning, base, project, preview),
    /unexpected managed projection/,
  );
});

test("migration replays its audit receipt after a lost completion marker", async (t) => {
  const base = makeBase("gsd-migrate-audit-lost-response-");
  t.after(() => {
    _setDomainOperationFaultForTest(null);
    cleanup(base);
  });
  const planning = createPlanningSource(base);
  mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
  const project = projectFixture();
  const preview = generatePreview(project);
  await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
  rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });

  _setDomainOperationFaultForTest("after-commit", "migration.audit");
  await assert.rejects(() => executeMigrationWrite(planning, base, project, preview), /after-commit/);
  _setDomainOperationFaultForTest(null);
  assert.equal(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'migration.audit'").get()?.["count"], 1);

  await executeMigrationWrite(planning, base, project, preview);
  assert.equal(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 0);
  assert.equal(_getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'migration.audit'").get()?.["count"], 1);
});

test("migration recovery arguments make either reviewed disposition selectable", () => {
  const evidence = {
    instructionIndex: 3,
    targetKind: "milestone",
    targetKey: "M001",
    reviewHash: `sha256:${"a".repeat(64)}`,
  };
  const token = Buffer.from(JSON.stringify(evidence), "utf8").toString("base64url");
  const parsed = parseMigrationRecoveryArgs(
    `--forward-choice=${token}.restore-backup \"/tmp/legacy planning\"`,
  );
  assert.equal(parsed.sourceArgs, "/tmp/legacy planning");
  assert.deepEqual(parsed.choices, [{ ...evidence, decision: "restore-backup" }]);
});

test("migration publication rejects self-hashed logical path traversal", async () => {
  const base = makeBase("gsd-migrate-publication-traversal-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));

    const applications = join(base, ".gsd", "migration-applications");
    const manifestPath = join(applications, readdirSync(applications)[0]!, "manifest.json");
    const envelope = JSON.parse(readFileSync(manifestPath, "utf8"));
    envelope.record.logicalPaths = ["../escaped.md"];
    envelope.payloadHash = hashLegacyImportValue(envelope.record);
    writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);

    assert.throws(
      () => findPendingMigrationPublication(planning, base),
      /logical path/i,
    );
  } finally {
    cleanup(base);
  }
});

test("completed migration replay repairs and revalidates durable outputs", async () => {
  const base = makeBase("gsd-migrate-publication-output-replay-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    const preview = generatePreview(project);
    const first = await executeMigrationWrite(planning, base, project, preview);
    const auditContent = readFileSync(first.audit.migrationPath, "utf8");
    rmSync(first.audit.migrationPath, { force: true });
    rmSync(first.legacyArchive.archivePath, { recursive: true, force: true });

    const replay = await executeMigrationWrite(planning, base, project, preview);
    assert.equal(existsSync(replay.audit.migrationPath), true);
    assert.equal(existsSync(join(replay.legacyArchive.archivePath, "STATE.md")), true);
    assert.equal(readFileSync(replay.audit.migrationPath, "utf8"), auditContent);
  } finally {
    cleanup(base);
  }
});

test("completed migration replay routes changed canonical targets through Forward Repair", async () => {
  const base = makeBase("gsd-migrate-publication-target-replay-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    const preview = generatePreview(project);
    await executeMigrationWrite(planning, base, project, preview);
    recordAcceptedOperation("migration-review.overlap", () => {
      _getAdapter()!.prepare("UPDATE milestones SET title = 'later overlapping work' WHERE id = 'M001'").run();
    });

    const replay = await executeMigrationWrite(planning, base, project, preview);
    assert.equal(getMilestone("M001")?.title, "later overlapping work");
    assert.ok(replay.verification.forwardRepairOperationId);
    assert.equal(
      _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"],
      1,
    );
  } finally {
    cleanup(base);
  }
});

test("later artifact overlap pauses with evidence-bound reviewed choices", async () => {
  const base = makeBase("gsd-migrate-artifact-overlap-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    project.milestones[0]!.research = "# Reviewed research\n";
    await executeMigrationWrite(planning, base, project, generatePreview(project));
    recordAcceptedOperation("migration-review.artifact-overlap", () => {
      _getAdapter()!.prepare(`UPDATE artifacts SET full_content = 'later accepted research'
        WHERE path = '.gsd/milestones/M001/M001-RESEARCH.md'`).run();
    });
    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, generatePreview(project)),
      /explicit reviewed choice[\s\S]*current=.*later accepted research[\s\S]*preserve:[\s\S]*restore:/i,
    );
  } finally {
    cleanup(base);
  }
});

test("retained Application replay rejects uncoordinated artifact row corruption", async () => {
  const base = makeBase("gsd-migrate-artifact-replay-row-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    project.milestones[0]!.research = "# Reviewed research\n";
    await executeMigrationWrite(planning, base, project, generatePreview(project));
    _getAdapter()!.prepare(`UPDATE artifacts SET full_content = 'uncoordinated corruption'
      WHERE path = '.gsd/milestones/M001/M001-RESEARCH.md'`).run();
    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, generatePreview(project)),
      /Application|canonical target|retained/i,
    );
  } finally {
    cleanup(base);
  }
});

test("migration rejects a staged artifact omitted from Application targets", async () => {
  const base = makeBase("gsd-migrate-staged-artifact-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));

    const applications = join(base, ".gsd", "migration-applications");
    const application = join(applications, readdirSync(applications)[0]!);
    const manifestPath = join(application, "manifest.json");
    const envelope = JSON.parse(readFileSync(manifestPath, "utf8"));
    const projectPath = join(application, "projection", "PROJECT.md");
    const sha256 = `sha256:${createHash("sha256").update(readFileSync(projectPath)).digest("hex")}`;
    envelope.record.artifactHashes = [{ logicalPath: "PROJECT.md", sha256 }];
    envelope.payloadHash = hashLegacyImportValue(envelope.record);
    writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /source set|staged artifact/i,
    );
  } finally {
    cleanup(base);
  }
});

test("Forward Repair rejects symlinked canonical artifact ancestors before mutation", async () => {
  const base = makeBase("gsd-migrate-symlink-parent-");
  const outside = makeBase("gsd-migrate-symlink-outside-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    recordAcceptedOperation("migration-review.symlink-parent", () => {
      insertArtifact({
        path: ".gsd/notes/later.md",
        artifact_type: "note",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "later canonical artifact\n",
      });
    });
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });
    write(join(outside, "later.md"), "outside authority\n");
    symlinkSync(outside, join(base, ".gsd", "notes"), "dir");

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /symbolic link|ancestor/i,
    );
    assert.equal(readFileSync(join(outside, "later.md"), "utf8"), "outside authority\n");
  } finally {
    cleanup(base);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("migration re-proves projection files immediately before completion", async () => {
  const base = makeBase("gsd-migrate-projection-race-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    const preview = generatePreview(project);
    let tampered = false;
    _setMigrationPublicationPlatformForTest("win32");
    _setMigrationDirectorySyncForTest(() => {
      const roadmap = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
      if (!tampered && existsSync(roadmap)) {
        writeFileSync(roadmap, "# raced projection\n");
        tampered = true;
      }
    });

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /projection/i,
    );
    assert.equal(tampered, true);
  } finally {
    _setMigrationPublicationPlatformForTest(null);
    _setMigrationDirectorySyncForTest(null);
    cleanup(base);
  }
});

test("Forward Repair reserves active authority paths from artifact publication", async () => {
  const base = makeBase("gsd-migrate-control-artifact-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    recordAcceptedOperation("migration-review.control-artifact", () => {
      insertArtifact({
        path: ".gsd/active.json",
        artifact_type: "control",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "untrusted control replacement\n",
      });
    });
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /reserved.*path|control.*path/i,
    );
    assert.equal(existsSync(join(base, ".gsd", "active.json")), false);
  } finally {
    cleanup(base);
  }
});

test("canonical artifacts reserve normalized control aliases", () => {
  const base = makeBase("gsd-migrate-control-alias-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    for (const path of [
      ".gsd/Backups/verified.db",
      ".gsd/ACTIVE.JSON",
      ".gsd/ACTIVE.JSON.",
      ".gsd/BACKUPS /verified.db",
      ".gsd/unit-claims.db",
      ".gsd/unit-claims.db-wal",
      ".gsd/notes/.gsd-projection-tmp-report.md",
      ".gsd/.compat.json",
      ".gsd/orchestrator.json ",
      ".gsd/slice-orchestrator.json.",
      ".gsd/auto.lock",
      ".gsd/active.json::$DATA",
      ".gsd/Migration/evidence.json",
    ]) {
      insertArtifact({
        path,
        artifact_type: "control",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "untrusted\n",
      });
    }
    assert.throws(() => canonicalMigrationArtifactProjection(), /reserved control path/i);
  } finally {
    cleanup(base);
  }
});

test("canonical artifacts reject normalized structured projection aliases", () => {
  const base = makeBase("gsd-migrate-structured-alias-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    insertArtifact({
      path: ".gsd/roadmap.md.",
      artifact_type: "alias",
      milestone_id: null,
      slice_id: null,
      task_id: null,
      full_content: "ambiguous\n",
    });

    assert.throws(() => canonicalForwardMigrationProjection(), /alias|conflicting canonical projection/i);
  } finally {
    cleanup(base);
  }
});

test("canonical artifacts reject Unicode-normalized projection aliases", () => {
  const base = makeBase("gsd-migrate-unicode-alias-");
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    for (const path of [".gsd/notes/café.md", ".gsd/notes/café.md"]) {
      insertArtifact({
        path,
        artifact_type: "alias",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: path,
      });
    }

    assert.throws(() => canonicalMigrationArtifactProjection(), /alias|collision/i);
  } finally {
    cleanup(base);
  }
});

test("managed-output history removes artifacts rendered between migration attempts", async () => {
  const base = makeBase("gsd-migrate-managed-intermediate-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    const preview = generatePreview(project);
    await executeMigrationWrite(planning, base, project, preview);
    recordAcceptedOperation("migration-review.intermediate-create", () => {
      insertArtifact({
        path: "milestones/M001/M001-RESEARCH.md",
        artifact_type: "RESEARCH",
        milestone_id: "M001",
        slice_id: null,
        task_id: null,
        full_content: "intermediate artifact\n",
      });
    });
    assert.equal(await renderMilestoneArtifactsFromDb(base, "M001"), true);
    // T008 stamp fallout reconciliation: the stamped replay re-renders the
    // migration's CONTEXT projection into the renderer's own (unprefixed)
    // ledger row, while the migration write's `.gsd/`-prefixed ledger row keeps
    // the application-evidence bytes — two divergent canonical representations
    // of one projection. The migration ledger row is tamper-evidence-hashed and
    // must not be rewritten (doing so trips Forward Repair's
    // CREATED_ARTIFACT_CHANGED_LATER reviewed-choice demand), so retire the
    // renderer's duplicate rows for projections the migration ledger already
    // represents. The audit's byte-exact canonical-representation check is
    // untouched: afterwards each projection has exactly one representation.
    recordAcceptedOperation("migration-review.render-duplicate-retire", () => {
      _getAdapter()!.prepare(`
        DELETE FROM artifacts
        WHERE path NOT LIKE '.gsd/%'
          AND EXISTS (
            SELECT 1 FROM artifacts AS ledger
            WHERE ledger.path = '.gsd/' || artifacts.path
          )
      `).run();
    });
    const intermediate = join(base, ".gsd", "milestones", "M001", "M001-RESEARCH.md");
    assert.equal(existsSync(intermediate), true);
    recordAcceptedOperation("migration-review.intermediate-delete", () => {
      _getAdapter()!.prepare(
        "DELETE FROM artifacts WHERE artifact_type = 'RESEARCH' AND milestone_id = 'M001'",
      ).run();
    });
    await executeMigrationWrite(planning, base, project, preview);
    assert.equal(existsSync(intermediate), false);
  } finally {
    cleanup(base);
  }
});

test("Forward Repair removes artifacts retained in the managed-output ledger", async () => {
  const base = makeBase("gsd-migrate-managed-ledger-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    const preview = generatePreview(project);
    await executeMigrationWrite(planning, base, project, preview);
    recordAcceptedOperation("migration-review.ledger-create", () => {
      insertArtifact({
        path: ".gsd/notes/later.md",
        artifact_type: "note",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "later canonical artifact\n",
      });
    });
    await executeMigrationWrite(planning, base, project, preview);
    assert.equal(existsSync(join(base, ".gsd", "notes", "later.md")), true);

    recordAcceptedOperation("migration-review.ledger-delete", () => {
      _getAdapter()!.prepare("DELETE FROM artifacts WHERE path = '.gsd/notes/later.md'").run();
    });
    await executeMigrationWrite(planning, base, project, preview);
    assert.equal(existsSync(join(base, ".gsd", "notes", "later.md")), false);
  } finally {
    cleanup(base);
  }
});

test("Forward Repair rejects conflicting artifact and structured projection content", async () => {
  const base = makeBase("gsd-migrate-projection-collision-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    recordAcceptedOperation("migration-review.projection-collision", () => {
      insertArtifact({
        path: ".gsd/ROADMAP.md",
        artifact_type: "collision",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "conflicting canonical artifact\n",
      });
    });
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /conflicting canonical projection/i,
    );
  } finally {
    cleanup(base);
  }
});

test("migration rejects incomplete retained audit receipt components", async () => {
  const base = makeBase("gsd-migrate-audit-components-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });
    _setDomainOperationFaultForTest("after-commit", "migration.audit");
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview), /after-commit/);
    _setDomainOperationFaultForTest(null);
    const operation = _getAdapter()!.prepare(
      "SELECT operation_id FROM workflow_operations WHERE operation_type = 'migration.audit'",
    ).get()!;
    _getAdapter()!.exec("DROP TRIGGER trg_workflow_outbox_delete");
    _getAdapter()!.prepare(`
      DELETE FROM workflow_outbox
      WHERE event_id IN (SELECT event_id FROM workflow_domain_events WHERE operation_id = :operation_id)
    `).run({ ":operation_id": operation["operation_id"] });

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /receipt components/i,
    );
  } finally {
    _setDomainOperationFaultForTest(null);
    cleanup(base);
  }
});

test("migration rejects a retained audit receipt with a changed operation header", async () => {
  const base = makeBase("gsd-migrate-audit-header-");
  try {
    const planning = createPlanningSource(base);
    mkdirSync(join(base, ".gsd", "PROJECT.md"), { recursive: true });
    const project = projectFixture();
    const preview = generatePreview(project);
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview));
    rmSync(join(base, ".gsd", "PROJECT.md"), { recursive: true, force: true });
    _setDomainOperationFaultForTest("after-commit", "migration.audit");
    await assert.rejects(() => executeMigrationWrite(planning, base, project, preview), /after-commit/);
    _setDomainOperationFaultForTest(null);
    _getAdapter()!.prepare(`
      UPDATE workflow_operations SET actor_id = 'tampered'
      WHERE operation_type = 'migration.audit'
    `).run();

    await assert.rejects(
      () => executeMigrationWrite(planning, base, project, preview),
      /receipt.*header|operation.*component/i,
    );
  } finally {
    _setDomainOperationFaultForTest(null);
    cleanup(base);
  }
});

test("migration audit replay verifies immutable request evidence after later artifact writes", async () => {
  const base = makeBase("gsd-migrate-audit-immutable-");
  try {
    const planning = createPlanningSource(base);
    const project = projectFixture();
    await executeMigrationWrite(planning, base, project, generatePreview(project));
    const row = _getAdapter()!.prepare(`
      SELECT idempotency_key FROM workflow_operations WHERE operation_type = 'migration.audit'
    `).get()!;
    const parts = String(row["idempotency_key"]).split("/");
    recordAcceptedOperation("migration-review.audit-update", () => {
      insertArtifact({
        path: "migration/MIGRATION.md",
        artifact_type: "migration-audit",
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: "later accepted audit note\n",
      });
    });
    assert.ok(inspectCommittedMigrationAudit(
      base,
      parts[1]!,
      parts[2]!,
      Number(parts[3]),
      Number(parts[4]),
    ));
  } finally {
    cleanup(base);
  }
});

test("managed projection scan rejects unsupported filesystem nodes", { skip: process.platform === "win32" }, () => {
  const base = makeBase("gsd-migrate-managed-node-");
  try {
    const path = join(base, ".gsd", "milestones", "M777", "M777-ROADMAP.md");
    mkdirSync(join(path, ".."), { recursive: true });
    execFileSync("mkfifo", [path]);
    assert.throws(
      () => managedStructuredProjectionPaths(base),
      /unsupported managed projection node/i,
    );
  } finally {
    cleanup(base);
  }
});
