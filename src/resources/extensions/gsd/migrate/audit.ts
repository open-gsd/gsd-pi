// gsd-pi - /gsd migrate audit helpers.
// File Purpose: Legacy archive, migration manifest, and projection verification support.

import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { atomicWriteSync } from "../atomic-write.js";
import { getAllMilestones, getArtifact, getArtifactsByPathPrefix, getMilestoneSlices, getSliceTasks, insertArtifact } from "../gsd-db.js";
import {
  assertDomainOperationReceiptComponents,
  executeDomainOperation,
  inspectDomainOperationReceipt,
  type DomainOperationMutation,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "../db/domain-operation.js";
import { getDb } from "../db/engine.js";
import { renderAllFromDb } from "../markdown-renderer.js";
import { inspectLegacyImportApplicationEvidence } from "../legacy-import-application-evidence.js";
import {
  verifyLegacyImportApplicationResult,
  verifyLegacyImportApplicationTargets,
} from "../legacy-import-application-result.js";
import { hashLegacyImportValue } from "../legacy-import-preview.js";
import type { LegacyImportValue } from "../legacy-import-contract.js";
import { gsdRoot } from "../paths.js";
import { countDbHierarchy, countMarkdownHierarchy, type HierarchyCounts } from "../migration-auto-check.js";
import { renderPlanContent, renderRoadmapContent, renderTopLevelRoadmapContent } from "../workflow-projections.js";
import type { MigrationPreview, WrittenFiles } from "./writer.js";

const RESERVED_PROJECTION_ROOTS = new Set([
  "backups",
  "migration",
  "migration-applications",
  "recovery-applications",
  "recovery",
  "receipts",
  "runtime",
  "worktrees",
]);

const RESERVED_PROJECTION_FILES = new Set([
  ".compat.json",
  "active.json",
  "auto.lock",
  "managed-projection-paths.json",
  "orchestrator.json",
  "slice-orchestrator.json",
  "state-manifest.json",
  "unit-claims.db",
]);

interface ImportedMigrationCounts {
  decisions: number;
  requirements: number;
  artifacts: number;
  hierarchy: HierarchyCounts;
  targets: readonly MigrationApplicationTarget[];
  application: MigrationApplicationEvidence;
}

interface MigrationApplicationTarget {
  readonly targetKind: string;
  readonly targetKey: string;
  readonly contentHash: string;
}

interface MigrationApplicationEvidence {
  readonly operationId: string;
  readonly previewId: string;
  readonly resultingRevision: number;
  readonly resultingAuthorityEpoch: number;
  readonly previewHash: string;
  readonly sourceSetHash: string;
  readonly changeSetHash: string;
  readonly applicationRelevantRowsHash: string;
  readonly projectionTargets: readonly MigrationProjectionTarget[];
  readonly targets: readonly MigrationApplicationTarget[];
}

export interface LegacyArchiveResult {
  archived: boolean;
  archivePath: string;
  manifestPath: string;
  strategy: "full-source-copy";
}

export interface MigrationProjectionVerification {
  markdown: HierarchyCounts;
  db: HierarchyCounts;
  dbReadiness: {
    phase: string;
    registry: number;
  };
  rendered: number;
  skipped: number;
  errors: string[];
  importedTargets: readonly MigrationProjectionTarget[];
  applicationOperationId: string | null;
  forwardRepairOperationId: string | null;
}

export interface MigrationProjectionTarget {
  readonly sourceId: string;
  readonly logicalPath: string;
  readonly sha256: string;
}

export interface MigrationAuditResult {
  migrationPath: string;
  manifestPath: string;
  importedArtifacts: number;
}

export interface MigrationAuditInput {
  sourcePath: string;
  targetRoot: string;
  backupPath: string | null;
  preview: MigrationPreview;
  written: WrittenFiles;
  imported: ImportedMigrationCounts;
  legacyArchive: LegacyArchiveResult;
  verification: MigrationProjectionVerification;
  startedAt: string;
  completedAt: string;
}

function relToGsd(targetRoot: string, path: string): string {
  return relative(gsdRoot(targetRoot), path).replaceAll("\\", "/");
}

function sameCounts(a: HierarchyCounts, b: HierarchyCounts): boolean {
  return a.milestones === b.milestones && a.slices === b.slices && a.tasks === b.tasks;
}

function previewHierarchy(preview: MigrationPreview): HierarchyCounts {
  return {
    milestones: preview.milestoneCount,
    slices: preview.totalSlices,
    tasks: preview.totalTasks,
  };
}

function fileSha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function canonicalProjectionLogicalPath(value: string): string {
  const logicalPath = value.replace(/^\.gsd[\\/]/u, "").replaceAll("\\", "/");
  if (logicalPath.length === 0
    || logicalPath.startsWith("/")
    || /^[a-zA-Z]:/u.test(logicalPath)
    || logicalPath.includes("\0")
    || logicalPath.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`canonical projection path is invalid: ${value}`);
  }
  const components = logicalPath.split("/").map((part) => (
    part.normalize("NFC").toLocaleLowerCase("en-US").replace(/[ .]+$/u, "")
  ));
  const [folded] = components;
  if (components.some((part) => part.length === 0
      || part.includes(":")
      || part.startsWith(".gsd-projection-tmp-")
      || /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/u.test(part))
    || RESERVED_PROJECTION_FILES.has(folded!)
    || /^gsd\.db(?:-|\.|$)/u.test(folded!)
    || /^unit-claims\.db(?:-|\.|$)/u.test(folded!)
    || RESERVED_PROJECTION_ROOTS.has(folded!)) {
    throw new Error(`canonical artifact uses a reserved control path: ${value}`);
  }
  return logicalPath;
}

function projectionAliasKey(logicalPath: string): string {
  return logicalPath.split("/")
    .map((part) => part.normalize("NFC").toLocaleLowerCase("en-US").replace(/[ .]+$/u, ""))
    .join("/");
}

function verifyImportedTargets(
  targetRoot: string,
  targets: readonly MigrationProjectionTarget[],
  errors: string[],
): void {
  const projectionRoot = resolve(gsdRoot(targetRoot));
  for (const target of targets) {
    const targetPath = resolve(projectionRoot, target.logicalPath);
    if (!targetPath.startsWith(`${projectionRoot}${sep}`) || !existsSync(targetPath) || fileSha256(targetPath) !== target.sha256) {
      errors.push(`imported projection target ${target.logicalPath} did not match reviewed content`);
    }
  }
}

function applicationEvidence(
  imported: ImportedMigrationCounts,
  errors: string[],
  verification: "exact" | "targets" | "evidence" = "exact",
): {
  operationId: string;
  projectionTargets: readonly MigrationProjectionTarget[];
} {
  const durable = inspectLegacyImportApplicationEvidence(imported.application.operationId);
  if (verification === "exact") verifyLegacyImportApplicationResult(durable);
  if (verification === "targets") verifyLegacyImportApplicationTargets(durable);
  const retainedArtifactTargets = imported.targets
    .filter((target) => target.targetKind === "artifact")
    .map((target) => {
      const instruction = durable.plan.instructions.find((candidate) => (
        candidate.targetKind === "artifact" && candidate.targetKey === target.targetKey && "values" in candidate
      ));
      const contentHash = instruction !== undefined && "values" in instruction
        ? instruction.values?.["content_hash"]
        : undefined;
      if (typeof contentHash !== "string") {
        errors.push(`migration artifact ${target.targetKey} lacks retained content evidence`);
      }
      const logicalPath = canonicalProjectionLogicalPath(target.targetKey);
      return {
        sourceId: `migration-artifact:${logicalPath}`,
        logicalPath,
        sha256: `sha256:${String(contentHash ?? "")}`,
      };
    });
  const projectionTargets = [
    ...durable.preview.preview.sources
    .filter((source) => source.path !== ".gsd/state-manifest.json")
    .map((source) => ({
      sourceId: source.source_id,
      logicalPath: source.path.replace(/^\.gsd\//u, ""),
      sha256: source.sha256,
    })),
    ...retainedArtifactTargets,
  ].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  const expectedArtifactTargets = imported.targets
    .filter((target) => target.targetKind === "artifact")
    .map((target) => canonicalProjectionLogicalPath(target.targetKey))
    .sort();
  // Both lists derive from the same imported targets, so dedupe is the only
  // difference — the count/hash comparison below is what detects drift or repeats.
  const importedArtifactTargets = [...new Set(expectedArtifactTargets)];
  if (imported.artifacts !== expectedArtifactTargets.length
    || hashLegacyImportValue(importedArtifactTargets) !== hashLegacyImportValue(expectedArtifactTargets)) {
    errors.push(`migration artifact target count, identity, or content evidence did not match retained Application (${imported.artifacts}/${expectedArtifactTargets.length})`);
  }
  const importedIdentities = new Set(imported.targets.map((target) => `${target.targetKind}\0${target.targetKey}`));
  const retainedInstructions = durable.plan.instructions.filter((instruction) => (
    importedIdentities.has(`${instruction.targetKind}\0${instruction.targetKey}`)
  ));
  const targets = retainedInstructions.map((instruction) => ({
    targetKind: instruction.targetKind,
    targetKey: instruction.targetKey,
    contentHash: hashLegacyImportValue(instruction as unknown as LegacyImportValue),
  }));
  if (verification !== "evidence") {
    for (const instruction of retainedInstructions) {
      if (instruction.targetKind !== "artifact" || !("values" in instruction)) continue;
      const expectedContent = instruction.values?.["full_content"];
      if (typeof expectedContent !== "string" || getArtifact(instruction.targetKey)?.full_content !== expectedContent) {
        errors.push(`canonical target artifact/${instruction.targetKey} did not match retained Application content`);
      }
    }
  }
  const expected = {
    operationId: durable.operationId,
    previewId: durable.preview.preview.preview_id,
    resultingRevision: durable.resultingProjectRevision,
    resultingAuthorityEpoch: durable.resultingAuthorityEpoch,
    previewHash: durable.preview.preview_hash,
    sourceSetHash: durable.preview.preview.source_set_hash,
    changeSetHash: durable.preview.preview.change_set_hash,
    applicationRelevantRowsHash: durable.applicationRelevantRowsHash,
    projectionTargets,
    targets,
  };
  if (hashLegacyImportValue(imported.application as unknown as LegacyImportValue)
    !== hashLegacyImportValue(expected as unknown as LegacyImportValue)) {
    errors.push("migration projection evidence did not match its retained Import Application");
  }
  if (hashLegacyImportValue(imported.targets as unknown as LegacyImportValue)
    !== hashLegacyImportValue(targets as unknown as LegacyImportValue)) {
    errors.push("migration target evidence did not match its retained Import Application");
  }
  return { operationId: durable.operationId, projectionTargets };
}

export async function archiveLegacyPlanningDirectory(
  sourcePath: string,
  targetRoot: string,
  manifestSourcePath: string = sourcePath,
): Promise<LegacyArchiveResult> {
  const archiveRoot = join(gsdRoot(targetRoot), "migration", "legacy");
  const archivePath = join(archiveRoot, "planning");
  const manifestPath = join(archiveRoot, "manifest.json");

  if (existsSync(sourcePath)) {
    rmSync(archivePath, { recursive: true, force: true });
    cpSync(sourcePath, archivePath, { recursive: true });
  }

  const manifest = {
    sourcePath: manifestSourcePath,
    archivePath: relToGsd(targetRoot, archivePath),
    strategy: "full-source-copy",
    note: "Full .planning source copied so legacy content without a gsd-pi field is not lost.",
  };

  atomicWriteSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    archived: existsSync(archivePath),
    archivePath,
    manifestPath,
    strategy: "full-source-copy",
  };
}

export async function verifyMigrationProjection(
  targetRoot: string,
  preview: MigrationPreview,
  imported?: ImportedMigrationCounts,
): Promise<MigrationProjectionVerification> {
  if (imported) return verifyAppliedMigrationProjection(targetRoot, preview, imported);
  const render = await renderAllFromDb(targetRoot);
  const markdown = countMarkdownHierarchy(targetRoot);
  const db = countDbHierarchy();
  const expected = previewHierarchy(preview);
  const errors = [...render.errors];

  if (!sameCounts(db, expected)) {
    errors.push(
      `DB hierarchy ${db.milestones}M/${db.slices}S/${db.tasks}T did not match preview ${expected.milestones}M/${expected.slices}S/${expected.tasks}T`,
    );
  }
  if (!sameCounts(markdown, db)) {
    errors.push(
      `Markdown projection ${markdown.milestones}M/${markdown.slices}S/${markdown.tasks}T did not match DB hierarchy ${db.milestones}M/${db.slices}S/${db.tasks}T`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`migration projection verification failed: ${errors.join("; ")}`);
  }

  return {
    markdown,
    db,
    dbReadiness: { phase: "not-checked", registry: 0 },
    rendered: render.rendered,
    skipped: render.skipped,
    errors,
    importedTargets: [],
    applicationOperationId: null,
    forwardRepairOperationId: null,
  };
}

export function verifyAppliedMigrationProjection(
  targetRoot: string,
  preview: MigrationPreview,
  imported: ImportedMigrationCounts,
): MigrationProjectionVerification {
  const markdown = countMarkdownHierarchy(targetRoot);
  const db = countDbHierarchy();
  const expected = previewHierarchy(preview);
  const errors: string[] = [];
  const evidence = applicationEvidence(imported, errors);
  if (!sameCounts(imported.hierarchy, expected)) {
    errors.push(
      `Imported hierarchy ${imported.hierarchy.milestones}M/${imported.hierarchy.slices}S/${imported.hierarchy.tasks}T did not match preview ${expected.milestones}M/${expected.slices}S/${expected.tasks}T`,
    );
  }
  if (evidence.projectionTargets.length === 0) errors.push("imported projection targets were not provided");
  verifyImportedTargets(targetRoot, evidence.projectionTargets, errors);
  if (errors.length > 0) throw new Error(`migration projection verification failed: ${errors.join("; ")}`);
  return {
    markdown,
    db,
    dbReadiness: { phase: "not-checked", registry: 0 },
    rendered: 0,
    skipped: 0,
    errors,
    importedTargets: evidence.projectionTargets,
    applicationOperationId: evidence.operationId,
    forwardRepairOperationId: null,
  };
}

export function verifyRetainedMigrationProjection(
  targetRoot: string,
  preview: MigrationPreview,
  imported: ImportedMigrationCounts,
): MigrationProjectionVerification {
  const markdown = countMarkdownHierarchy(targetRoot);
  const db = countDbHierarchy();
  const expected = previewHierarchy(preview);
  const errors: string[] = [];
  const evidence = applicationEvidence(imported, errors, "targets");
  if (!sameCounts(imported.hierarchy, expected)) {
    errors.push(
      `Imported hierarchy ${imported.hierarchy.milestones}M/${imported.hierarchy.slices}S/${imported.hierarchy.tasks}T did not match preview ${expected.milestones}M/${expected.slices}S/${expected.tasks}T`,
    );
  }
  verifyImportedTargets(targetRoot, evidence.projectionTargets, errors);
  const expectedPaths = new Set(evidence.projectionTargets.map((target) => target.logicalPath));
  canonicalForwardMigrationProjection();
  for (const target of canonicalMigrationArtifactProjection()) {
    expectedPaths.add(target.logicalPath);
    const path = join(gsdRoot(targetRoot), target.logicalPath);
    if (!evidence.projectionTargets.some((reviewed) => reviewed.logicalPath === target.logicalPath)
      && (!existsSync(path) || readFileSync(path, "utf8") !== target.content)) {
      errors.push(`canonical projection target ${target.logicalPath} did not match current authority`);
    }
  }
  for (const logicalPath of managedStructuredProjectionPaths(targetRoot)) {
    if (!expectedPaths.has(logicalPath)) errors.push(`unexpected managed projection ${logicalPath}`);
  }
  if (errors.length > 0) throw new Error(`migration projection verification failed: ${errors.join("; ")}`);
  return {
    markdown,
    db,
    dbReadiness: { phase: "not-checked", registry: 0 },
    rendered: 0,
    skipped: 0,
    errors,
    importedTargets: evidence.projectionTargets,
    applicationOperationId: evidence.operationId,
    forwardRepairOperationId: null,
  };
}

export interface CanonicalMigrationProjectionTarget {
  readonly logicalPath: string;
  readonly content: string;
}

export function canonicalMigrationArtifactProjection(): CanonicalMigrationProjectionTarget[] {
  const targets: CanonicalMigrationProjectionTarget[] = [];
  const aliases = new Map<string, string>();
  for (const artifact of getArtifactsByPathPrefix("")) {
    const logicalPath = artifact.path.replace(/^\.gsd[\\/]/u, "").replaceAll("\\", "/");
    if ([
      "migration/MIGRATION.md",
      "migration/legacy/manifest.json",
      "migration/manifest.json",
    ].includes(logicalPath)) {
      continue;
    }
    const canonical = canonicalProjectionLogicalPath(artifact.path);
    const alias = projectionAliasKey(canonical);
    const existing = aliases.get(alias);
    if (existing !== undefined && existing !== canonical) {
      throw new Error(`canonical projection alias collision between ${existing} and ${canonical}`);
    }
    aliases.set(alias, canonical);
    targets.push({
      logicalPath: canonical,
      content: artifact.full_content,
    });
  }
  return targets.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

export function canonicalForwardMigrationProjection(): CanonicalMigrationProjectionTarget[] {
  const targets = new Map<string, { logicalPath: string; content: string; owner: string }>();
  const add = (logicalPath: string, content: string, owner: string): void => {
    const canonical = canonicalProjectionLogicalPath(logicalPath);
    const alias = projectionAliasKey(canonical);
    const existing = targets.get(alias);
    if (existing !== undefined
      && (existing.logicalPath !== canonical || existing.owner !== owner || existing.content !== content)) {
      throw new Error(`conflicting canonical projection representations at ${logicalPath}`);
    }
    targets.set(alias, { logicalPath: canonical, content, owner });
  };
  for (const artifact of canonicalMigrationArtifactProjection()) {
    add(artifact.logicalPath, artifact.content, `artifact:${artifact.logicalPath}`);
  }
  const milestones = getAllMilestones();
  add("ROADMAP.md", renderTopLevelRoadmapContent(milestones), "structured:roadmap");
  for (const milestone of milestones) {
    const slices = getMilestoneSlices(milestone.id).filter((slice) => slice.status !== "skipped");
    add(`milestones/${milestone.id}/${milestone.id}-ROADMAP.md`, renderRoadmapContent(milestone, slices), "structured:roadmap");
    for (const slice of slices) {
      const tasks = getSliceTasks(milestone.id, slice.id).filter((task) => task.status !== "skipped");
      if (tasks.length === 0) continue;
      add(
        `milestones/${milestone.id}/slices/${slice.id}/${slice.id}-PLAN.md`,
        renderPlanContent(slice, tasks),
        "structured:plan",
      );
    }
  }
  return [...targets.values()]
    .map((target) => ({ logicalPath: target.logicalPath, content: target.content }))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

export function managedStructuredProjectionPaths(targetRoot: string): string[] {
  const root = gsdRoot(targetRoot);
  const paths: string[] = [];
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`unexpected managed projection symbolic link at ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && /-(?:CONTEXT|PLAN|RESEARCH|ROADMAP|SUMMARY|VALIDATION)\.md$/u.test(entry)) {
        paths.push(relative(root, path).replaceAll("\\", "/"));
      } else if (!stat.isFile()) {
        throw new Error(`unsupported managed projection node at ${path}`);
      }
    }
  };
  visit(join(root, "milestones"));
  for (const name of ["DECISIONS.md", "PROJECT.md", "QUEUE.md", "REQUIREMENTS.md", "ROADMAP.md", "STATE.md"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`unexpected managed projection node at ${path}`);
    paths.push(name);
  }
  return paths.sort();
}

export function verifyForwardRepairedMigrationProjection(
  targetRoot: string,
  imported: ImportedMigrationCounts,
  forwardRepairOperationId: string,
): MigrationProjectionVerification {
  const errors: string[] = [];
  const evidence = applicationEvidence(imported, errors, "evidence");
  const targets = canonicalForwardMigrationProjection();
  const expectedPaths = new Set(targets.map((target) => target.logicalPath));
  for (const target of targets) {
    const path = join(gsdRoot(targetRoot), target.logicalPath);
    if (!existsSync(path) || readFileSync(path, "utf8") !== target.content) {
      errors.push(`canonical projection target ${target.logicalPath} did not match current authority`);
    }
  }
  for (const logicalPath of managedStructuredProjectionPaths(targetRoot)) {
    if (!expectedPaths.has(logicalPath)) errors.push(`unexpected managed projection ${logicalPath}`);
  }
  const importedTargets = targets.map((target) => ({
    sourceId: `canonical:${target.logicalPath}`,
    logicalPath: target.logicalPath,
    sha256: `sha256:${createHash("sha256").update(target.content).digest("hex")}`,
  }));
  if (errors.length > 0) throw new Error(`migration projection verification failed: ${errors.join("; ")}`);
  return {
    markdown: countMarkdownHierarchy(targetRoot),
    db: countDbHierarchy(),
    dbReadiness: { phase: "not-checked", registry: 0 },
    rendered: 0,
    skipped: 0,
    errors,
    importedTargets,
    applicationOperationId: evidence.operationId,
    forwardRepairOperationId,
  };
}

function migrationAuditIdempotencyKey(
  publicationKey: string,
  authorityReceiptId: string,
  expectedRevision: number,
  expectedAuthorityEpoch: number,
): string {
  return `migration.audit/${publicationKey}/${authorityReceiptId}/${expectedRevision}/${expectedAuthorityEpoch}`;
}

function migrationAuditMutation(
  publicationKey: string,
  authorityReceiptId: string,
  artifacts: readonly { readonly path: string; readonly sha256: string }[],
): DomainOperationMutation {
  return {
    events: [{
      eventType: "migration.audit.recorded",
      entityType: "migration",
      entityId: publicationKey,
      payload: {
        publicationKey,
        authorityReceiptId,
        artifacts: artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
      },
      destinations: ["projection"],
    }],
    projections: artifacts.map((artifact) => ({
      projectionKey: `migration/audit/${artifact.path}`.toLowerCase(),
      projectionKind: "migration-audit",
      rendererVersion: "1",
    })),
  };
}

function migrationAuditArtifacts(targetRoot: string) {
  return migrationAuditArtifactCandidates(targetRoot).map((candidate) => {
    if (!existsSync(candidate.path)) {
      throw new Error(`migration audit artifact is missing at ${candidate.path}`);
    }
    return {
      ...candidate,
      artifactPath: relToGsd(targetRoot, candidate.path),
      content: readFileSync(candidate.path, "utf8"),
    };
  });
}

function migrationAuditRequest(
  artifacts: ReturnType<typeof migrationAuditArtifacts>,
  publicationKey: string,
  authorityReceiptId: string,
  expectedRevision: number,
  expectedAuthorityEpoch: number,
): DomainOperationRequest {
  return {
    operationType: "migration.audit",
    idempotencyKey: migrationAuditIdempotencyKey(
      publicationKey,
      authorityReceiptId,
      expectedRevision,
      expectedAuthorityEpoch,
    ),
    expectedRevision,
    expectedAuthorityEpoch,
    actorType: "system",
    actorId: "gsd-migrate",
    sourceTransport: "internal",
    payload: {
      publicationKey,
      authorityReceiptId,
      artifacts: artifacts.map((artifact) => ({
        path: artifact.artifactPath,
        sha256: `sha256:${createHash("sha256").update(artifact.content).digest("hex")}`,
      })),
    },
  };
}

export function inspectCommittedMigrationAudit(
  _targetRoot: string,
  publicationKey: string,
  authorityReceiptId: string,
  expectedRevision: number,
  expectedAuthorityEpoch: number,
): DomainOperationResult | null {
  const receipt = inspectDomainOperationReceipt(
    "migration.audit",
    migrationAuditIdempotencyKey(
      publicationKey,
      authorityReceiptId,
      expectedRevision,
      expectedAuthorityEpoch,
    ),
  );
  if (receipt !== null) {
    const event = getDb().prepare(`
      SELECT payload_json FROM workflow_domain_events
      WHERE operation_id = :operation_id AND event_type = 'migration.audit.recorded'
    `).get({ ":operation_id": receipt.operationId }) as { payload_json?: unknown } | undefined;
    if (typeof event?.payload_json !== "string") {
      throw new Error("committed migration audit request evidence is missing");
    }
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    const rawArtifacts = payload["artifacts"];
    if (payload["publicationKey"] !== publicationKey
      || payload["authorityReceiptId"] !== authorityReceiptId
      || !Array.isArray(rawArtifacts)) {
      throw new Error("committed migration audit request evidence is invalid");
    }
    const artifacts = rawArtifacts.map((value) => {
      const artifact = value as Record<string, unknown>;
      if (typeof artifact["path"] !== "string"
        || !/^sha256:[a-f0-9]{64}$/u.test(String(artifact["sha256"]))) {
        throw new Error("committed migration audit request evidence is invalid");
      }
      return { path: String(artifact["path"]), sha256: String(artifact["sha256"]) };
    });
    const request: DomainOperationRequest = {
      operationType: "migration.audit",
      idempotencyKey: migrationAuditIdempotencyKey(
        publicationKey,
        authorityReceiptId,
        expectedRevision,
        expectedAuthorityEpoch,
      ),
      expectedRevision,
      expectedAuthorityEpoch,
      actorType: "system",
      actorId: "gsd-migrate",
      sourceTransport: "internal",
      payload: { publicationKey, authorityReceiptId, artifacts },
    };
    assertDomainOperationReceiptComponents(
      receipt,
      request,
      migrationAuditMutation(publicationKey, authorityReceiptId, artifacts),
    );
  }
  return receipt;
}

export function recordMigrationAuditArtifacts(
  targetRoot: string,
  publicationKey: string,
  authorityReceiptId: string,
  expectedRevision: number,
  expectedAuthorityEpoch: number,
): { importedArtifacts: number; operation: DomainOperationResult } {
  const artifacts = migrationAuditArtifacts(targetRoot);
  const operation = executeDomainOperation(migrationAuditRequest(
    artifacts,
    publicationKey,
    authorityReceiptId,
    expectedRevision,
    expectedAuthorityEpoch,
  ), () => {
    for (const artifact of artifacts) {
      insertArtifact({
        path: artifact.artifactPath,
        artifact_type: artifact.type,
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: artifact.content,
      });
    }
    return migrationAuditMutation(publicationKey, authorityReceiptId, artifacts.map((artifact) => ({
      path: artifact.artifactPath,
      sha256: `sha256:${createHash("sha256").update(artifact.content).digest("hex")}`,
    })));
  });
  for (const artifact of artifacts) {
    if (getArtifact(artifact.artifactPath)?.full_content !== artifact.content) {
      throw new Error(`migration audit artifact receipt did not match ${artifact.artifactPath}`);
    }
  }
  return { importedArtifacts: artifacts.length, operation };
}

function formatMigrationMarkdown(input: MigrationAuditInput): string {
  const backup = input.backupPath ? input.backupPath : "none";
  return [
    "# Migration Audit",
    "",
    `- Started: ${input.startedAt}`,
    `- Completed: ${input.completedAt}`,
    `- Source: ${input.sourcePath}`,
    `- Target: ${input.targetRoot}`,
    `- Backup: ${backup}`,
    `- Legacy archive: ${relToGsd(input.targetRoot, input.legacyArchive.archivePath)}`,
    "",
    "## Imported Counts",
    "",
    `- Decisions: ${input.imported.decisions}/${input.preview.decisions.total}`,
    `- Requirements: ${input.imported.requirements}/${input.preview.requirements.total}`,
    `- Milestones: ${input.imported.hierarchy.milestones}/${input.preview.milestoneCount}`,
    `- Slices: ${input.imported.hierarchy.slices}/${input.preview.totalSlices}`,
    `- Tasks: ${input.imported.hierarchy.tasks}/${input.preview.totalTasks}`,
    `- Artifacts: ${input.imported.artifacts}`,
    "",
    "## Projection Verification",
    "",
    `- DB: ${input.verification.db.milestones}M/${input.verification.db.slices}S/${input.verification.db.tasks}T`,
    `- Markdown: ${input.verification.markdown.milestones}M/${input.verification.markdown.slices}S/${input.verification.markdown.tasks}T`,
    `- DB readiness: ${input.verification.dbReadiness.phase} (${input.verification.dbReadiness.registry} milestone(s) visible)`,
    `- Rendered: ${input.verification.rendered}`,
    `- Skipped: ${input.verification.skipped}`,
    `- Imported targets verified: ${input.verification.importedTargets.length}`,
    `- Import Application: ${input.verification.applicationOperationId ?? "none"}`,
    "",
  ].join("\n");
}

export async function writeMigrationAudit(
  input: MigrationAuditInput,
  importArtifacts = true,
): Promise<MigrationAuditResult> {
  const migrationDir = join(gsdRoot(input.targetRoot), "migration");
  const migrationPath = join(migrationDir, "MIGRATION.md");
  const manifestPath = join(migrationDir, "manifest.json");

  const manifest = {
    sourcePath: input.sourcePath,
    targetRoot: input.targetRoot,
    backupPath: input.backupPath,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    preview: input.preview,
    written: input.written.counts,
    imported: input.imported,
    legacyArchive: {
      archived: input.legacyArchive.archived,
      path: relToGsd(input.targetRoot, input.legacyArchive.archivePath),
      manifestPath: relToGsd(input.targetRoot, input.legacyArchive.manifestPath),
      strategy: input.legacyArchive.strategy,
    },
    verification: input.verification,
  };

  atomicWriteSync(migrationPath, formatMigrationMarkdown(input));
  atomicWriteSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    migrationPath,
    manifestPath,
    importedArtifacts: importArtifacts ? importMigrationAuditArtifacts(input.targetRoot) : 0,
  };
}

export function importMigrationAuditArtifacts(targetRoot: string): number {
  const candidates = migrationAuditArtifactCandidates(targetRoot);

  let imported = 0;
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const path = relToGsd(targetRoot, candidate.path);
    const fullContent = readFileSync(candidate.path, "utf8");
    if (getArtifact(path)?.full_content !== fullContent) {
      insertArtifact({
        path,
        artifact_type: candidate.type,
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: fullContent,
      });
    }
    imported++;
  }
  return imported;
}

function migrationAuditArtifactCandidates(targetRoot: string): Array<{ path: string; type: string }> {
  return [
    { path: join(gsdRoot(targetRoot), "migration", "MIGRATION.md"), type: "MIGRATION_AUDIT" },
    { path: join(gsdRoot(targetRoot), "migration", "manifest.json"), type: "MIGRATION_MANIFEST" },
    { path: join(gsdRoot(targetRoot), "migration", "legacy", "manifest.json"), type: "MIGRATION_LEGACY_MANIFEST" },
  ];
}
