// Project/App: gsd-pi
// File Purpose: Durable migration publication staging and lost-response replay state.

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

import { hashLegacyImportValue } from "../legacy-import-preview.js";
import type { LegacyImportValue } from "../legacy-import-contract.js";
import type { VerifiedMigrationCounts } from "../db-workspace.js";
import type { MigrationBackup } from "./safety.js";
import type { MigrationPreview, WrittenFiles } from "./writer.js";
import { syncDirectoryEntry } from "@gsd/native/directory-sync";
import {
  acquireProjectionRootIdentityLock,
  type ProjectionRootIdentityLock,
} from "@gsd/native/file-identity";

let projectionMutationBoundaryForTest: ((boundary: "before-copy" | "after-copy") => void) | null = null;

export function _setProjectionMutationBoundaryForTest(
  hook: ((boundary: "before-copy" | "after-copy") => void) | null,
): void {
  projectionMutationBoundaryForTest = hook;
}

export interface MigrationPublicationRecord {
  readonly schemaVersion: 2;
  readonly publicationKey: string;
  readonly sourcePath: string;
  readonly targetRoot: string;
  readonly projectionRootIdentity: MigrationProjectionRootIdentity;
  readonly requestHash: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly preview: MigrationPreview;
  readonly backup: MigrationBackup;
  readonly writtenCounts: WrittenFiles["counts"];
  readonly logicalPaths: readonly string[];
  readonly managedProjectionPaths: readonly string[];
  readonly expectedTargets: readonly string[];
  readonly projectionHashes: readonly PublicationFileHash[];
  readonly artifactHashes: readonly PublicationFileHash[];
  readonly legacyHashes: readonly PublicationFileHash[];
  readonly phase: "prepared" | "applied" | "projected" | "complete";
  readonly legacyPreviewId: string | null;
  readonly legacyPreviewHash: string | null;
  readonly applicationOperationId: string | null;
  readonly forwardRepairOperationId: string | null;
  readonly auditOperationId: string | null;
  readonly imported: VerifiedMigrationCounts | null;
  readonly verification: unknown | null;
  readonly projectionRevision: number | null;
  readonly projectionAuthorityEpoch: number | null;
  readonly completedResult: unknown | null;
  readonly completionRevision: number | null;
  readonly completionAuthorityEpoch: number | null;
  readonly outputHashes: readonly PublicationFileHash[];
}

export interface MigrationProjectionRootIdentity {
  readonly targetPath: string;
  readonly targetDevice: string;
  readonly targetInode: string;
  readonly rootPath: string;
  readonly rootDevice: string | null;
  readonly rootInode: string | null;
}

export interface PublicationFileHash {
  readonly logicalPath: string;
  readonly sha256: string;
  readonly kind?: "file" | "directory";
}

let publicationPlatformForTest: NodeJS.Platform | null = null;
let directorySyncForTest: ((path: string) => void) | null = null;

export function _setMigrationPublicationPlatformForTest(platform: NodeJS.Platform | null): void {
  publicationPlatformForTest = platform;
}

export function _setMigrationDirectorySyncForTest(sync: ((path: string) => void) | null): void {
  directorySyncForTest = sync;
}

function contentHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function publicationKey(sourcePath: string, targetRoot: string, requestHash: string): string {
  return hashLegacyImportValue({ sourcePath, targetRoot, requestHash } as unknown as LegacyImportValue).slice(7);
}

function publicationDirectory(targetRoot: string, key: string): string {
  return join(targetRoot, ".gsd", "migration-applications", key);
}

function manifestPath(record: Pick<MigrationPublicationRecord, "targetRoot" | "publicationKey">): string {
  return join(publicationDirectory(record.targetRoot, record.publicationKey), "manifest.json");
}

function syncPath(path: string): void {
  // Windows fsync (FlushFileBuffers) requires a handle with GENERIC_WRITE, so
  // the sync handle opens read-write there; POSIX keeps read-only.
  const access = (publicationPlatformForTest ?? process.platform) === "win32" ? "r+" : "r";
  const descriptor = openSync(path, access);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  if ((publicationPlatformForTest ?? process.platform) === "win32") {
    (directorySyncForTest ?? syncDirectoryEntry)(path);
    return;
  }
  syncPath(path);
}

function requireCanonicalLogicalPath(value: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || value.includes("\0")
    || value.startsWith("/")
    || /^[a-zA-Z]:/u.test(value)) {
    throw new Error("migration publication logical path is not a canonical safe relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("migration publication logical path is not a canonical safe relative path");
  }
  return value;
}

function validateManifestPaths(record: MigrationPublicationRecord): void {
  if (!Array.isArray(record.logicalPaths)
    || !Array.isArray(record.projectionHashes)
    || !Array.isArray(record.managedProjectionPaths)
    || !Array.isArray(record.artifactHashes)
    || !Array.isArray(record.legacyHashes)
    || !Array.isArray(record.outputHashes)) {
    throw new Error("migration publication logical paths are invalid");
  }
  for (const path of record.logicalPaths) requireCanonicalLogicalPath(path);
  for (const path of record.managedProjectionPaths) requireCanonicalLogicalPath(path);
  for (const entry of [...record.projectionHashes, ...record.artifactHashes, ...record.legacyHashes, ...record.outputHashes]) {
    requireCanonicalLogicalPath(entry.logicalPath);
    if (entry.kind !== undefined && entry.kind !== "file" && entry.kind !== "directory") {
      throw new Error("migration publication logical paths are invalid");
    }
  }
}

function validProjectionRootIdentity(value: unknown): value is MigrationProjectionRootIdentity {
  if (value === null || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return typeof identity["targetPath"] === "string"
    && typeof identity["targetDevice"] === "string"
    && typeof identity["targetInode"] === "string"
    && typeof identity["rootPath"] === "string"
    && (identity["rootDevice"] === null || typeof identity["rootDevice"] === "string")
    && (identity["rootInode"] === null || typeof identity["rootInode"] === "string");
}

function requireSupportedNode(path: string): "file" | "directory" {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`migration publication encountered unsupported symbolic link at ${path}`);
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  throw new Error(`migration publication encountered unsupported filesystem node at ${path}`);
}

function syncTree(path: string): void {
  if (requireSupportedNode(path) === "file") {
    syncPath(path);
    return;
  }
  for (const entry of readdirSync(path)) syncTree(join(path, entry));
  syncDirectory(path);
}

function treeHashes(root: string): PublicationFileHash[] {
  try {
    lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const hashes: PublicationFileHash[] = [];
  const visit = (path: string): void => {
    if (requireSupportedNode(path) === "file") {
      hashes.push({
        logicalPath: relative(root, path).replaceAll("\\", "/"),
        sha256: contentHash(path),
        kind: "file",
      });
      return;
    }
    if (path !== root) {
      hashes.push({
        logicalPath: relative(root, path).replaceAll("\\", "/"),
        sha256: "directory",
        kind: "directory",
      });
    }
    for (const entry of readdirSync(path).sort()) visit(join(path, entry));
  };
  visit(root);
  return hashes.sort((left, right) => {
    if (left.logicalPath < right.logicalPath) return -1;
    if (left.logicalPath > right.logicalPath) return 1;
    return 0;
  });
}

function retainedTreeHashes(
  handle: ProjectionRootIdentityLock,
  relativeRoot: string,
): PublicationFileHash[] {
  if (!handle.pathExists(relativeRoot)) return [];
  const hashes: PublicationFileHash[] = [];
  const visit = (directory: string, logicalRoot: string): void => {
    for (const name of handle.listDirectory(directory)) {
      const relativePath = `${directory}/${requireCanonicalLogicalPath(name)}`;
      const logicalPath = logicalRoot.length === 0 ? name : `${logicalRoot}/${name}`;
      const kind = handle.pathKind(relativePath);
      if (kind === "directory") {
        hashes.push({ logicalPath, sha256: "directory", kind: "directory" });
        visit(relativePath, logicalPath);
      } else {
        hashes.push({
          logicalPath,
          sha256: `sha256:${createHash("sha256").update(handle.readFile(relativePath)).digest("hex")}`,
          kind: "file",
        });
      }
    }
  };
  visit(relativeRoot, "");
  return hashes.sort((left, right) => {
    if (left.logicalPath < right.logicalPath) return -1;
    if (left.logicalPath > right.logicalPath) return 1;
    return 0;
  });
}

function publicationIntent(input: {
  sourcePath: string;
  targetRoot: string;
  requestHash: string;
}, key: string): Record<string, string | number> {
  return {
    schemaVersion: 1,
    publicationKey: key,
    sourcePath: resolve(input.sourcePath),
    targetRoot: resolve(input.targetRoot),
    requestHash: input.requestHash,
  };
}

function persistPublicationIntent(
  handle: ProjectionRootIdentityLock,
  input: { sourcePath: string; targetRoot: string; requestHash: string },
  key: string,
): void {
  const path = `migration-applications/${key}.intent.json`;
  const expected = publicationIntent(input, key);
  if (handle.pathExists(path)) {
    const observed = JSON.parse(handle.readFile(path).toString("utf8")) as unknown;
    if (hashLegacyImportValue(observed as LegacyImportValue)
      !== hashLegacyImportValue(expected as unknown as LegacyImportValue)) {
      throw new Error("migration publication recovery intent does not match the reviewed request");
    }
    return;
  }
  handle.writeFile(path, Buffer.from(`${JSON.stringify(expected, null, 2)}\n`));
}

function removeRetainedTree(handle: ProjectionRootIdentityLock, relativePath: string): void {
  if (!handle.pathExists(relativePath)) return;
  if (handle.pathKind(relativePath) === "file") {
    handle.removeFile(relativePath);
    return;
  }
  for (const name of handle.listDirectory(relativePath)) {
    removeRetainedTree(handle, `${relativePath}/${requireCanonicalLogicalPath(name)}`);
  }
  handle.removeDirectory(relativePath);
}

function persistAtRoot(
  record: MigrationPublicationRecord,
  projectionRoot: string,
  handle: ProjectionRootIdentityLock,
): MigrationPublicationRecord {
  const normalized = JSON.parse(JSON.stringify(record)) as MigrationPublicationRecord;
  assertProjectionRoot(normalized, false, normalized.projectionRootIdentity);
  const logicalPath = `migration-applications/${normalized.publicationKey}/manifest.json`;
  const path = join(projectionRoot, logicalPath);
  const payloadHash = hashLegacyImportValue(normalized as unknown as LegacyImportValue);
  handle.writeFile(logicalPath, Buffer.from(`${JSON.stringify({ record: normalized, payloadHash }, null, 2)}\n`));
  syncPath(path);
  syncDirectory(dirname(dirname(path)));
  syncDirectory(dirname(dirname(dirname(path))));
  assertProjectionRoot(normalized, false, normalized.projectionRootIdentity);
  return normalized;
}

function persist(
  record: MigrationPublicationRecord,
  projectionRoot?: string,
  handle?: ProjectionRootIdentityLock,
): MigrationPublicationRecord {
  if (projectionRoot !== undefined && handle !== undefined) return persistAtRoot(record, projectionRoot, handle);
  return withMigrationProjectionRoot(record.targetRoot, record.projectionRootIdentity, (boundRoot, rootHandle) => (
    persistAtRoot(record, boundRoot, rootHandle)
  ));
}

function load(
  path: string,
  canonicalPath = path,
  projectionRoot?: string,
  handle?: ProjectionRootIdentityLock,
): MigrationPublicationRecord {
  const manifestRelative = projectionRoot === undefined ? null : relative(projectionRoot, path).replaceAll("\\", "/");
  const bytes = handle !== undefined && manifestRelative !== null
    ? handle.readFile(requireCanonicalLogicalPath(manifestRelative))
    : readFileSync(path);
  const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const record = parsed["record"] as MigrationPublicationRecord;
  if (record?.schemaVersion !== 2 || !validProjectionRootIdentity(record.projectionRootIdentity)) {
    throw new Error("migration publication manifest is invalid");
  }
  validateManifestPaths(record);
  const retainedRoot = projectionRoot === undefined
    ? publicationDirectory(record.targetRoot, record.publicationKey)
    : join(projectionRoot, "migration-applications", record.publicationKey);
  const observedProjectionHashes = handle === undefined
    ? treeHashes(join(retainedRoot, "projection"))
    : retainedTreeHashes(handle, `migration-applications/${record.publicationKey}/projection`);
  const observedLegacyHashes = handle === undefined
    ? treeHashes(join(retainedRoot, "legacy", "planning"))
    : retainedTreeHashes(handle, `migration-applications/${record.publicationKey}/legacy/planning`);
  if (parsed["payloadHash"] !== hashLegacyImportValue(record as unknown as LegacyImportValue)
    || record.publicationKey !== publicationKey(record.sourcePath, record.targetRoot, record.requestHash)
    || manifestPath(record) !== canonicalPath
    || hashLegacyImportValue(observedProjectionHashes)
      !== hashLegacyImportValue(record.projectionHashes)
    || hashLegacyImportValue(observedLegacyHashes)
      !== hashLegacyImportValue(record.legacyHashes)) {
    throw new Error("migration publication manifest is invalid");
  }
  assertProjectionRoot(record, false, record.projectionRootIdentity);
  return record;
}

export function findMigrationPublication(
  sourcePath: string,
  targetRoot: string,
  requestHash: string,
  projectionRootIdentity?: MigrationProjectionRootIdentity,
): MigrationPublicationRecord | null {
  const identity = assertProjectionRoot({ targetRoot }, false, projectionRootIdentity);
  if (identity.rootDevice === null) return null;
  const key = publicationKey(sourcePath, targetRoot, requestHash);
  return withMigrationProjectionRoot(targetRoot, identity, (root, handle) => {
    const manifest = `migration-applications/${key}/manifest.json`;
    if (!handle.pathExists(manifest)) return null;
    const path = join(root, "migration-applications", key, "manifest.json");
    return load(path, manifestPath({ targetRoot, publicationKey: key }), root, handle);
  });
}

export function findPendingMigrationPublication(
  sourcePath: string,
  targetRoot: string,
  projectionRootIdentity?: MigrationProjectionRootIdentity,
): MigrationPublicationRecord | null {
  const identity = assertProjectionRoot({ targetRoot }, false, projectionRootIdentity);
  if (identity.rootDevice === null) return null;
  return withMigrationProjectionRoot(targetRoot, identity, (projectionRoot, handle) => {
    const root = join(projectionRoot, "migration-applications");
    if (!handle.pathExists("migration-applications")) return null;
    const pending = handle.listDirectory("migration-applications")
      .filter((key) => handle.pathKind(`migration-applications/${requireCanonicalLogicalPath(key)}`) === "directory")
      .filter((key) => handle.pathExists(`migration-applications/${key}/manifest.json`))
      .map((key) => ({ key: requireCanonicalLogicalPath(key), path: join(root, key, "manifest.json") }))
      .map(({ key, path }) => load(path, manifestPath({ targetRoot, publicationKey: key }), projectionRoot, handle))
      .filter((record) => record.phase !== "complete"
        && record.sourcePath === resolve(sourcePath)
        && record.targetRoot === resolve(targetRoot));
    if (pending.length > 1) throw new Error("multiple migration Applications require publication recovery");
    return pending[0] ?? null;
  });
}

export function migrationPublicationRequestHash(sourcePath: string, stagedGsd: string): string {
  return hashLegacyImportValue({
    legacy: treeHashes(sourcePath),
    projection: treeHashes(stagedGsd),
  });
}

export function prepareMigrationPublication(input: {
  sourcePath: string;
  targetRoot: string;
  requestHash: string;
  startedAt: string;
  preview: MigrationPreview;
  backup: MigrationBackup;
  stagedGsd: string;
  staged: WrittenFiles;
  expectedTargets: readonly string[];
  projectionRootIdentity?: MigrationProjectionRootIdentity;
}): MigrationPublicationRecord {
  const projectionRootIdentity = assertProjectionRoot(
    { targetRoot: input.targetRoot },
    true,
    input.projectionRootIdentity,
  );
  return withMigrationProjectionRoot(input.targetRoot, projectionRootIdentity, (boundRoot, handle) => {
    const key = publicationKey(input.sourcePath, input.targetRoot, input.requestHash);
    const directory = join(boundRoot, "migration-applications", key);
    const existingPath = join(directory, "manifest.json");
    if (handle.pathExists(`migration-applications/${key}/manifest.json`)) {
      return load(existingPath, manifestPath({ targetRoot: input.targetRoot, publicationKey: key }), boundRoot, handle);
    }
    persistPublicationIntent(handle, input, key);
    removeRetainedTree(handle, `migration-applications/${key}`);

    const logicalPaths: string[] = [];
    for (const entry of treeHashes(input.stagedGsd)) {
      const logicalPath = requireCanonicalLogicalPath(entry.logicalPath);
      const retainedPath = `migration-applications/${key}/projection/${logicalPath}`;
      if (entry.kind === "directory") {
        handle.createDirectory(retainedPath);
        continue;
      }
      const source = join(input.stagedGsd, logicalPath);
      projectionMutationBoundaryForTest?.("before-copy");
      handle.copyFile(source, retainedPath);
      projectionMutationBoundaryForTest?.("after-copy");
      const retainedHash = `sha256:${createHash("sha256").update(handle.readFile(
        retainedPath,
      )).digest("hex")}`;
      if (contentHash(source) !== retainedHash) {
        throw new Error(`migration publication copy changed ${logicalPath}`);
      }
      logicalPaths.push(logicalPath);
    }
    if (existsSync(input.sourcePath)) {
      for (const entry of treeHashes(input.sourcePath)) {
        const logicalPath = requireCanonicalLogicalPath(entry.logicalPath);
        const retainedPath = `migration-applications/${key}/legacy/planning/${logicalPath}`;
        if (entry.kind === "directory") handle.createDirectory(retainedPath);
        else handle.copyFile(join(input.sourcePath, logicalPath), retainedPath);
      }
    }
    const projectionHashes = retainedTreeHashes(handle, `migration-applications/${key}/projection`);
    const stagedArtifacts = new Set((input.staged.artifactPaths ?? []).map((path) => (
      requireCanonicalLogicalPath(relative(input.stagedGsd, path).replaceAll("\\", "/"))
    )));
    const artifactHashes = projectionHashes.filter((entry) => stagedArtifacts.has(entry.logicalPath));
    const legacyHashes = retainedTreeHashes(handle, `migration-applications/${key}/legacy/planning`);
    const retainedRequestHash = hashLegacyImportValue({ legacy: legacyHashes, projection: projectionHashes });
    if (retainedRequestHash !== input.requestHash) {
      removeRetainedTree(handle, `migration-applications/${key}`);
      throw new Error("migration publication retained evidence does not match the reviewed request hash");
    }

    return persist({
      schemaVersion: 2,
      publicationKey: key,
      sourcePath: resolve(input.sourcePath),
      targetRoot: resolve(input.targetRoot),
      projectionRootIdentity,
      requestHash: input.requestHash,
      startedAt: input.startedAt,
      completedAt: null,
      preview: input.preview,
      backup: input.backup,
      writtenCounts: input.staged.counts,
      logicalPaths,
      managedProjectionPaths: [...logicalPaths].sort(),
      expectedTargets: [...input.expectedTargets].sort(),
      projectionHashes,
      artifactHashes,
      legacyHashes,
      phase: "prepared",
      legacyPreviewId: null,
      legacyPreviewHash: null,
      applicationOperationId: null,
      forwardRepairOperationId: null,
      auditOperationId: null,
      imported: null,
      verification: null,
      projectionRevision: null,
      projectionAuthorityEpoch: null,
      completedResult: null,
      completionRevision: null,
      completionAuthorityEpoch: null,
      outputHashes: [],
    }, boundRoot, handle);
  });
}

export function proveMigrationProjectionRoot(targetRoot: string): MigrationProjectionRootIdentity {
  const target = lstatSync(targetRoot, { bigint: true });
  if (target.isSymbolicLink() || !target.isDirectory()) {
    throw new Error("migration projection target root is not a directory");
  }
  const canonicalTarget = realpathSync(targetRoot);
  const rootPath = join(targetRoot, ".gsd");
  try {
    const stat = lstatSync(rootPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("migration projection root is not a directory");
    }
    return {
      targetPath: canonicalTarget,
      targetDevice: target.dev.toString(),
      targetInode: target.ino.toString(),
      rootPath: realpathSync(rootPath),
      rootDevice: stat.dev.toString(),
      rootInode: stat.ino.toString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      targetPath: canonicalTarget,
      targetDevice: target.dev.toString(),
      targetInode: target.ino.toString(),
      rootPath: join(canonicalTarget, ".gsd"),
      rootDevice: null,
      rootInode: null,
    };
  }
}

function sameProjectionRootIdentity(
  left: MigrationProjectionRootIdentity,
  right: MigrationProjectionRootIdentity,
): boolean {
  return left.targetPath === right.targetPath
    && left.targetDevice === right.targetDevice
    && left.targetInode === right.targetInode
    && left.rootPath === right.rootPath
    && left.rootDevice === right.rootDevice
    && left.rootInode === right.rootInode;
}

function assertProjectionRoot(
  record: Pick<MigrationPublicationRecord, "targetRoot">,
  create = false,
  expectedIdentity?: MigrationProjectionRootIdentity,
): MigrationProjectionRootIdentity {
  const before = proveMigrationProjectionRoot(record.targetRoot);
  if (expectedIdentity !== undefined && !sameProjectionRootIdentity(before, expectedIdentity)) {
    throw new Error("migration projection root identity changed");
  }
  const rootPath = join(record.targetRoot, ".gsd");
  if (before.rootDevice === null) {
    if (!create) return before;
    mkdirSync(rootPath);
  }
  const after = proveMigrationProjectionRoot(record.targetRoot);
  if (before.rootDevice !== null && !sameProjectionRootIdentity(before, after)) {
    throw new Error("migration projection root identity changed");
  }
  return after;
}

export function withMigrationProjectionRoot<T>(
  targetRoot: string,
  expectedIdentity: MigrationProjectionRootIdentity,
  operation: (boundRoot: string, handle: ProjectionRootIdentityLock) => T,
): T {
  const identity = assertProjectionRoot({ targetRoot }, false, expectedIdentity);
  if (identity.rootDevice === null || identity.rootInode === null) {
    throw new Error("migration projection root does not exist");
  }
  const lock = acquireProjectionRootIdentityLock(
    identity.rootPath,
    identity.rootDevice,
    identity.rootInode,
  );
  try {
    assertProjectionRoot({ targetRoot }, false, identity);
    return operation(identity.rootPath, lock);
  } finally {
    lock.close();
  }
}

export function assertMigrationProjectionRootIdentity(
  record: Pick<MigrationPublicationRecord, "targetRoot" | "projectionRootIdentity">,
): void {
  assertProjectionRoot(record, false, record.projectionRootIdentity);
}

function assertMigrationProjectionTarget(
  record: Pick<MigrationPublicationRecord, "targetRoot">
    & Partial<Pick<MigrationPublicationRecord, "projectionRootIdentity">>,
  logicalPath: string,
): string {
  const canonical = requireCanonicalLogicalPath(logicalPath);
  const root = join(record.targetRoot, ".gsd");
  const parts = canonical.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (existsSync(parent)) {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`migration projection ancestor is unsafe at ${parent}`);
    }
  }
  const path = join(root, ...parts);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`migration projection target is an unsupported node at ${path}`);
    }
  }
  return canonical;
}

export function writeMigrationProjectionFile(
  record: Pick<MigrationPublicationRecord, "targetRoot">
    & Partial<Pick<MigrationPublicationRecord, "projectionRootIdentity">>,
  logicalPath: string,
  content: string,
): string {
  const canonical = assertMigrationProjectionTarget(record, logicalPath);
  const identity = assertProjectionRoot(record, false, record.projectionRootIdentity);
  return withMigrationProjectionRoot(record.targetRoot, identity, (_root, handle) => {
    if (handle.pathExists(canonical) && handle.pathKind(canonical) !== "file") {
      throw new Error(`migration projection target is an unsupported node at ${logicalPath}`);
    }
    handle.writeFile(canonical, Buffer.from(content));
    assertProjectionRoot(record, false, identity);
    return join(record.targetRoot, ".gsd", ...canonical.split("/"));
  });
}

export function removeMigrationProjectionPath(
  record: Pick<MigrationPublicationRecord, "targetRoot">
    & Partial<Pick<MigrationPublicationRecord, "projectionRootIdentity">>,
  logicalPath: string,
): string | null {
  const canonical = assertMigrationProjectionTarget(record, logicalPath);
  const identity = assertProjectionRoot(record, false, record.projectionRootIdentity);
  const publishedPath = join(record.targetRoot, ".gsd", ...canonical.split("/"));
  return withMigrationProjectionRoot(record.targetRoot, identity, (_root, handle) => {
    if (!handle.pathExists(canonical)) return null;
    if (handle.pathKind(canonical) !== "file") {
      throw new Error(`migration projection target is an unsupported node at ${logicalPath}`);
    }
    handle.removeFile(canonical);
    assertProjectionRoot(record, false, identity);
    return dirname(publishedPath);
  });
}

export function migrationPublicationProjectionRoot(record: MigrationPublicationRecord): string {
  return join(publicationDirectory(record.targetRoot, record.publicationKey), "projection");
}

export function migrationPublicationLegacyPath(record: MigrationPublicationRecord): string {
  return join(publicationDirectory(record.targetRoot, record.publicationKey), "legacy", "planning");
}

export function materializeMigrationPublicationEvidence(
  record: MigrationPublicationRecord,
  destinationRoot: string,
): { projectionRoot: string; legacyPath: string } {
  const projectionRoot = join(destinationRoot, "projection");
  const legacyPath = join(destinationRoot, "legacy", "planning");
  withMigrationProjectionRoot(record.targetRoot, record.projectionRootIdentity, (_root, handle) => {
    for (const entry of record.projectionHashes) {
      const path = join(projectionRoot, requireCanonicalLogicalPath(entry.logicalPath));
      if (entry.kind === "directory") {
        mkdirSync(path, { recursive: true });
        continue;
      }
      const bytes = handle.readFile(`migration-applications/${record.publicationKey}/projection/${entry.logicalPath}`);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.sha256) {
        throw new Error(`migration publication projection evidence changed at ${entry.logicalPath}`);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    for (const entry of record.legacyHashes) {
      const path = join(legacyPath, requireCanonicalLogicalPath(entry.logicalPath));
      if (entry.kind === "directory") {
        mkdirSync(path, { recursive: true });
        continue;
      }
      const bytes = handle.readFile(`migration-applications/${record.publicationKey}/legacy/planning/${entry.logicalPath}`);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== entry.sha256) {
        throw new Error(`migration publication legacy evidence changed at ${entry.logicalPath}`);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  });
  return { projectionRoot, legacyPath };
}

export function syncPublishedMigrationFiles(record: MigrationPublicationRecord): void {
  withMigrationProjectionRoot(record.targetRoot, record.projectionRootIdentity, (_root, handle) => {
    const directories = new Set<string>();
    for (const logicalPath of record.logicalPaths) {
      const canonical = requireCanonicalLogicalPath(logicalPath);
      handle.syncFile(canonical);
      const parts = canonical.split("/");
      for (let length = parts.length - 1; length > 0; length--) {
        directories.add(parts.slice(0, length).join("/"));
      }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      handle.syncDirectory(directory);
    }
  });
}

export function syncMigrationPublicationOutputs(
  record: MigrationPublicationRecord,
  paths: readonly string[],
): PublicationFileHash[] {
  return withMigrationProjectionRoot(record.targetRoot, record.projectionRootIdentity, (boundRoot, handle) => {
    const root = realpathSync(record.targetRoot);
    const lexicalRoot = resolve(record.targetRoot);
    const lexicalProjectionRoot = join(lexicalRoot, ".gsd");
    const files: PublicationFileHash[] = [];
    const directories = new Set<string>();
    for (const outputPath of paths) {
      const resolvedOutput = resolve(outputPath);
      const projectionRelative = relative(lexicalProjectionRoot, resolvedOutput).replaceAll("\\", "/");
      const isProjection = projectionRelative.length === 0
        || (!projectionRelative.startsWith("../") && projectionRelative !== "..");
      if (isProjection && projectionRelative.length > 0) {
        const canonical = requireCanonicalLogicalPath(projectionRelative);
        const logicalBase = join(lexicalProjectionRoot, canonical);
        if (handle.pathKind(canonical) === "file") {
          const bytes = handle.readFile(canonical);
          files.push({
            logicalPath: relative(lexicalRoot, logicalBase).replaceAll("\\", "/"),
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          });
          handle.syncFile(canonical);
        } else {
          const tree = retainedTreeHashes(handle, canonical);
          for (const entry of tree) {
            files.push({
              logicalPath: relative(lexicalRoot, join(logicalBase, entry.logicalPath)).replaceAll("\\", "/"),
              sha256: entry.sha256,
            });
            if (entry.kind === "file") handle.syncFile(`${canonical}/${entry.logicalPath}`);
          }
          for (const entry of tree.filter((entry) => entry.kind === "directory")
            .sort((left, right) => right.logicalPath.length - left.logicalPath.length)) {
            handle.syncDirectory(`${canonical}/${entry.logicalPath}`);
          }
          handle.syncDirectory(canonical);
        }
        const parts = canonical.split("/");
        for (let length = parts.length - 1; length > 0; length--) {
          handle.syncDirectory(parts.slice(0, length).join("/"));
        }
        continue;
      }
      const absolute = isProjection
        ? projectionRelative.length === 0
          ? boundRoot
          : join(boundRoot, requireCanonicalLogicalPath(projectionRelative))
        : realpathSync(outputPath);
      const logicalBase = isProjection ? join(lexicalProjectionRoot, projectionRelative) : absolute;
      if (!isProjection && absolute !== root && !absolute.startsWith(`${root}/`) && !absolute.startsWith(`${root}\\`)) {
        throw new Error("migration publication output escaped its project root");
      }
      if (!existsSync(absolute)) throw new Error(`migration publication output is missing at ${outputPath}`);
      for (const entry of treeHashes(absolute)) {
        const path = entry.logicalPath.length === 0 ? logicalBase : join(logicalBase, entry.logicalPath);
        files.push({
          logicalPath: relative(isProjection ? lexicalRoot : root, path).replaceAll("\\", "/"),
          sha256: entry.sha256,
        });
      }
      syncTree(absolute);
      for (let directory = dirname(absolute); directory.startsWith(isProjection ? boundRoot : root); directory = dirname(directory)) {
        directories.add(directory);
        if (directory === (isProjection ? boundRoot : root)) break;
      }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      syncDirectory(directory);
    }
    return files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  });
}

export function syncMigrationPublicationDirectories(
  record: Pick<MigrationPublicationRecord, "targetRoot">
    & Partial<Pick<MigrationPublicationRecord, "projectionRootIdentity">>,
  paths: readonly string[],
): void {
  const identity = assertProjectionRoot(record, false, record.projectionRootIdentity);
  withMigrationProjectionRoot(record.targetRoot, identity, (root, handle) => {
    const lexicalRoot = join(record.targetRoot, ".gsd");
    for (const entry of new Set(paths)) {
      const relativePath = relative(lexicalRoot, entry).replaceAll("\\", "/");
      const path = relativePath.length === 0 ? root : join(root, requireCanonicalLogicalPath(relativePath));
      if (requireSupportedNode(path) !== "directory") {
        throw new Error(`migration publication durability target is not a directory: ${entry}`);
      }
      if (relativePath.length > 0) handle.syncDirectory(relativePath);
      else handle.syncRoot();
    }
  });
}

export function updateMigrationPublication(
  record: MigrationPublicationRecord,
  update: Partial<MigrationPublicationRecord>,
): MigrationPublicationRecord {
  return persist({ ...record, ...update });
}

/** Completed publications are audit history, not replay state; retain 30 days. */
export const MIGRATION_COMPLETED_PUBLICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Intent files and partial retained trees are crash remnants of an interrupted
 * prepare. They are only pruned once older than an hour so an in-flight
 * prepare (intent persisted, manifest not yet written) is never collected.
 */
export const MIGRATION_PARTIAL_PUBLICATION_RETENTION_MS = 60 * 60 * 1000;

function completedPublicationCompletedAt(bytes: Buffer): number | null {
  // Best-effort parse: a manifest that cannot be positively confirmed as a
  // completed publication is kept — deleting pending replay evidence is the
  // dangerous failure mode, keeping history is the safe one.
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const record = parsed["record"] as Record<string, unknown> | undefined;
    if (record?.["phase"] !== "complete" || typeof record["completedAt"] !== "string") return null;
    const completedAt = Date.parse(record["completedAt"]);
    return Number.isFinite(completedAt) ? completedAt : null;
  } catch {
    return null;
  }
}

export function pruneMigrationPublications(
  targetRoot: string,
  projectionRootIdentity?: MigrationProjectionRootIdentity,
  now: number = Date.now(),
): void {
  const identity = assertProjectionRoot({ targetRoot }, false, projectionRootIdentity);
  if (identity.rootDevice === null) return;
  withMigrationProjectionRoot(targetRoot, identity, (boundRoot, handle) => {
    if (!handle.pathExists("migration-applications")) return;
    const entries = handle.listDirectory("migration-applications")
      .map((name) => requireCanonicalLogicalPath(name));
    const manifestedKeys = new Set(entries.filter((name) => !name.endsWith(".intent.json")
      && handle.pathKind(`migration-applications/${name}`) === "directory"
      && handle.pathExists(`migration-applications/${name}/manifest.json`)));
    const entryMtime = (name: string): number => (
      lstatSync(join(boundRoot, "migration-applications", name)).mtimeMs
    );
    for (const name of entries) {
      if (name.endsWith(".intent.json")) {
        const key = name.slice(0, -".intent.json".length);
        if (key.length === 0) throw new Error("migration publication intent name is invalid");
        if (manifestedKeys.has(key)) continue;
        if (now - entryMtime(name) < MIGRATION_PARTIAL_PUBLICATION_RETENTION_MS) continue;
        handle.removeFile(`migration-applications/${name}`);
        removeRetainedTree(handle, `migration-applications/${key}`);
        continue;
      }
      if (!handle.pathExists(`migration-applications/${name}`)) continue;
      if (handle.pathKind(`migration-applications/${name}`) !== "directory") {
        throw new Error("migration publication entry is an unsupported node");
      }
      const manifest = `migration-applications/${name}/manifest.json`;
      if (!handle.pathExists(manifest)) {
        if (now - entryMtime(name) < MIGRATION_PARTIAL_PUBLICATION_RETENTION_MS) continue;
        removeRetainedTree(handle, `migration-applications/${name}`);
        continue;
      }
      const completedAt = completedPublicationCompletedAt(handle.readFile(manifest));
      if (completedAt === null || now - completedAt < MIGRATION_COMPLETED_PUBLICATION_RETENTION_MS) continue;
      removeRetainedTree(handle, `migration-applications/${name}`);
      const intent = `migration-applications/${name}.intent.json`;
      if (handle.pathExists(intent)) handle.removeFile(intent);
    }
  });
}
