import { isNativeAddonLoaded, native } from "../native.js";

export interface SqliteFileIdentityLock {
  close(): void;
}

export interface ProjectionRootIdentityLock {
  createDirectory(relativePath: string): void;
  copyFile(source: string, relativePath: string): void;
  writeFile(relativePath: string, content: Buffer): void;
  writeFileWithTemporary(relativePath: string, temporaryPath: string, content: Buffer): void;
  prepareFileTemporary(temporaryPath: string, content: Buffer): string;
  prepareDirectoryPlaceholder(relativePath: string): string;
  exchangePaths(leftPath: string, rightPath: string, leftIdentity: string, rightIdentity: string, guardPath: string, guardIdentity: string): void;
  publishFileTemporary(relativePath: string, temporaryPath: string, identity: string): void;
  pathIdentity(relativePath: string): string;
  removeFileIfIdentity(relativePath: string, identity: string): void;
  removeFileViaGuardExact(relativePath: string, identity: string, guardPath: string, directory: boolean, contentDigest: string, deleting?: boolean): void;
  acknowledgeTreeDeletionEvidence(relativePath: string, identity: string): void;
  quarantineFile(relativePath: string, quarantinePath: string): string;
  quarantineFileIfIdentity(relativePath: string, quarantinePath: string, identity: string, placeholderIdentity: string, guardPath: string, guardIdentity: string): void;
  readFile(relativePath: string): Buffer;
  listDirectory(relativePath: string): string[];
  pathExists(relativePath: string): boolean;
  pathKind(relativePath: string): "file" | "directory";
  removeDirectory(relativePath: string): void;
  removeTree(relativePath: string): void;
  quarantineTree(relativePath: string, quarantinePath: string): string;
  quarantineTreeIfIdentity(relativePath: string, quarantinePath: string, identity: string, placeholderIdentity: string, guardPath: string, guardIdentity: string): void;
  removeQuarantinedTree(quarantinePath: string, identity: string): void;
  restoreQuarantinedTreeExact(quarantinePath: string, relativePath: string, identity: string, contentDigest: string): void;
  removeFile(relativePath: string): void;
  syncFile(relativePath: string): void;
  syncDirectory(relativePath: string): void;
  syncRoot(): void;
  close(): void;
}

export function isSqliteFileIdentityLockAvailable(): boolean {
  return isNativeAddonLoaded() && typeof native.SqliteFileIdentityLock === "function";
}

export function isProjectionRootIdentityLockAvailable(): boolean {
  return isNativeAddonLoaded() && typeof native.ProjectionRootIdentityLock === "function";
}

export function acquireSqliteFileIdentityLock(path: string, create: boolean): SqliteFileIdentityLock {
  const Lock = native.SqliteFileIdentityLock;
  // When the addon fails to load, `native` is a throw-on-call proxy whose
  // every property reads back as an arrow function: the typeof guard passes
  // but `new Lock(...)` dies with a bare "not a constructor" TypeError. Check
  // the load state first so callers get the intended unavailable error. The
  // typeof guard still covers a real-but-stale addon lacking this export.
  if (!isSqliteFileIdentityLockAvailable()) throw new Error("native SQLite file identity locking is unavailable");
  try {
    return new Lock(path, create) as SqliteFileIdentityLock;
  } catch (error) {
    throw new Error("native SQLite file identity locking failed", { cause: error });
  }
}

export function acquireProjectionRootIdentityLock(
  path: string,
  expectedDevice: string,
  expectedInode: string,
): ProjectionRootIdentityLock {
  const Lock = native.ProjectionRootIdentityLock;
  // See acquireSqliteFileIdentityLock: detect the throw-on-call proxy via the
  // load state, not just typeof, so the failure reads "unavailable".
  if (!isProjectionRootIdentityLockAvailable()) throw new Error("native projection root identity locking is unavailable");
  try {
    return new Lock(path, expectedDevice, expectedInode) as ProjectionRootIdentityLock;
  } catch (error) {
    throw new Error("native projection root identity locking failed", { cause: error });
  }
}
