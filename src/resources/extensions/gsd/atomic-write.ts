import { closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, renameSync, unlinkSync, mkdirSync, promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { acquireProjectionRootIdentityLock, isProjectionRootIdentityLockAvailable, type ProjectionRootIdentityLock } from "@gsd/native/file-identity";
import { syncDirectoryEntry } from "@gsd/native/directory-sync";
import { withProjectionMutation, withProjectionMutationSync } from "./database-maintenance-fence.js";
import {
  abortManagedProjectionMutation,
  applyManagedProjectionMutation,
  beginManagedProjectionMutation,
  commitManagedProjectionMutation,
  createManagedProjectionDirectorySync,
  removeLegacyProjectionTreeSync,
  retainManagedProjectionMutation,
} from "./managed-projection-history.js";
import { classifyGsdLogicalPath } from "./projection-path-policy.js";
import { preserveManagedProjectionBeforeMutation } from "./projection-mutation-guard.js";
export { removeLegacyProjectionTreeSync };

const TRANSIENT_LOCK_ERROR_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_RENAME_ATTEMPTS = 5;
const SYNC_SLEEP_BUFFER = new SharedArrayBuffer(4);
const SYNC_SLEEP_VIEW = new Int32Array(SYNC_SLEEP_BUFFER);

type ManagedMutationBoundary = "before-write" | "after-write" | "after-remove";

let managedMutationBoundaryForTest: ((boundary: ManagedMutationBoundary, filePath: string) => void) | null = null;
let projectionCopyBoundaryForTest: (() => void) | null = null;

export function _setManagedMutationBoundaryForTest(
  hook: ((boundary: ManagedMutationBoundary, filePath: string) => void) | null,
): void {
  managedMutationBoundaryForTest = hook;
}

export function _setProjectionCopyBoundaryForTest(hook: (() => void) | null): void {
  projectionCopyBoundaryForTest = hook;
}

type RetryableEncoding = BufferEncoding;
type MkdirOptions = { recursive: true };

export interface AtomicWriteAsyncOps {
  mkdir(path: string, options: MkdirOptions): Promise<void>;
  writeFile(path: string, content: string, encoding: RetryableEncoding): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  createTempPath?(filePath: string): string;
  fsyncFile?(path: string): Promise<void>;
  fsyncDirectory?(path: string): Promise<void>;
}

export interface AtomicWriteSyncOps {
  mkdir(path: string, options: MkdirOptions): void;
  writeFile(path: string, content: string, encoding: RetryableEncoding): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  sleep(ms: number): void;
  createTempPath?(filePath: string): string;
  fsyncFile?(path: string): void;
  fsyncDirectory?(path: string): void;
}

function defaultTempPath(filePath: string): string {
  return filePath + `.tmp.${randomBytes(4).toString("hex")}`;
}

function computeRetryDelayMs(attempt: number): number {
  const base = 8 * attempt;
  const jitter = randomBytes(1)[0] % 5;
  return base + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(SYNC_SLEEP_VIEW, 0, 0, ms);
}

function normalizeErrnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isTransientLockError(error: unknown): boolean {
  const code = normalizeErrnoCode(error);
  return typeof code === "string" && TRANSIENT_LOCK_ERROR_CODES.has(code);
}

function buildAtomicWriteError(filePath: string, attempts: number, error: unknown): Error {
  const code = normalizeErrnoCode(error) ?? "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    `Atomic write to ${filePath} failed after ${attempts} attempts (last error code: ${code}): ${message}`,
  ) as NodeJS.ErrnoException;
  wrapped.code = code;
  if (error instanceof Error && "stack" in error && error.stack) {
    wrapped.stack = error.stack;
  }
  return wrapped;
}

async function cleanupTempFileAsync(tmpPath: string, ops: AtomicWriteAsyncOps): Promise<void> {
  try {
    await ops.unlink(tmpPath);
  } catch {
    // Best-effort cleanup only.
  }
}

function cleanupTempFileSync(tmpPath: string, ops: AtomicWriteSyncOps): void {
  try {
    ops.unlink(tmpPath);
  } catch {
    // Best-effort cleanup only.
  }
}

/** @internal Exported for retry/cleanup tests. */
export async function atomicWriteAsyncWithOps(
  filePath: string,
  content: string,
  encoding: RetryableEncoding = "utf-8",
  ops: AtomicWriteAsyncOps,
): Promise<void> {
  await ops.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = ops.createTempPath?.(filePath) ?? defaultTempPath(filePath);
  await ops.writeFile(tmpPath, content, encoding);
  // Flush the temp file to stable storage before the rename so a crash cannot
  // leave a torn or zero-length target behind.
  await ops.fsyncFile?.(tmpPath);

  let lastError: unknown = null;
  let attempts = 0;

  for (attempts = 1; attempts <= MAX_RENAME_ATTEMPTS; attempts++) {
    try {
      await ops.rename(tmpPath, filePath);
      // Persist the directory entry created by the rename.
      await ops.fsyncDirectory?.(dirname(filePath));
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientLockError(error) || attempts === MAX_RENAME_ATTEMPTS) {
        break;
      }
      await ops.sleep(computeRetryDelayMs(attempts));
    }
  }

  await cleanupTempFileAsync(tmpPath, ops);
  throw buildAtomicWriteError(filePath, attempts, lastError);
}

/** @internal Exported for retry/cleanup tests. */
export function atomicWriteSyncWithOps(
  filePath: string,
  content: string,
  encoding: RetryableEncoding = "utf-8",
  ops: AtomicWriteSyncOps,
): void {
  ops.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = ops.createTempPath?.(filePath) ?? defaultTempPath(filePath);
  ops.writeFile(tmpPath, content, encoding);
  // Flush the temp file to stable storage before the rename so a crash cannot
  // leave a torn or zero-length target behind.
  ops.fsyncFile?.(tmpPath);

  let lastError: unknown = null;
  let attempts = 0;

  for (attempts = 1; attempts <= MAX_RENAME_ATTEMPTS; attempts++) {
    try {
      ops.rename(tmpPath, filePath);
      // Persist the directory entry created by the rename.
      ops.fsyncDirectory?.(dirname(filePath));
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientLockError(error) || attempts === MAX_RENAME_ATTEMPTS) {
        break;
      }
      ops.sleep(computeRetryDelayMs(attempts));
    }
  }

  cleanupTempFileSync(tmpPath, ops);
  throw buildAtomicWriteError(filePath, attempts, lastError);
}

// Windows fsync (FlushFileBuffers) requires a handle with GENERIC_WRITE, so
// sync handles open read-write there; POSIX keeps O_RDONLY (same convention as
// legacy-import-backup.ts hashSnapshotPass).
function fsyncFileSyncImpl(path: string): void {
  const access = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  const fd = openSync(path, access);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function fsyncFileAsyncImpl(path: string): Promise<void> {
  const handle = await fs.open(path, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Same convention as legacy-import-backup.ts syncDirectory: POSIX opens the
// directory and fsyncs it; win32 goes through the native directory entry sync.
function fsyncDirectorySyncImpl(path: string): void {
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

async function fsyncDirectoryAsyncImpl(path: string): Promise<void> {
  if (process.platform === "win32") {
    syncDirectoryEntry(path);
    return;
  }
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const DEFAULT_ASYNC_OPS: AtomicWriteAsyncOps = {
  mkdir: async (path, options) => {
    await fs.mkdir(path, options);
  },
  writeFile: (path, content, encoding) => fs.writeFile(path, content, encoding),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
  sleep: delay,
  fsyncFile: fsyncFileAsyncImpl,
  fsyncDirectory: fsyncDirectoryAsyncImpl,
};

const DEFAULT_SYNC_OPS: AtomicWriteSyncOps = {
  mkdir: (path, options) => mkdirSync(path, options),
  writeFile: (path, content, encoding) => writeFileSync(path, content, encoding),
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
  sleep: sleepSync,
  fsyncFile: fsyncFileSyncImpl,
  fsyncDirectory: fsyncDirectorySyncImpl,
};

/**
 * Atomically writes content to a file by writing to a temp file first,
 * then renaming. Prevents partial/corrupt files on crash.
 */
export function atomicWriteSync(filePath: string, content: string, encoding: BufferEncoding = "utf-8"): void {
  withProjectionMutationSync(filePath, () => {
    preserveManagedProjectionBeforeMutation(filePath, Buffer.from(content, encoding));
    const mutation = beginManagedProjectionMutation(filePath, "write", content, encoding);
    let managedApplyStarted = false;
    try {
      managedMutationBoundaryForTest?.("before-write", filePath);
      managedApplyStarted = mutation !== null;
      if (!applyManagedProjectionMutation(mutation)) {
        atomicWriteSyncWithOps(filePath, content, encoding, DEFAULT_SYNC_OPS);
      }
      managedMutationBoundaryForTest?.("after-write", filePath);
    } catch (error) {
      if (managedApplyStarted) retainManagedProjectionMutation(mutation);
      else abortManagedProjectionMutation(mutation);
      throw error;
    }
    commitManagedProjectionMutation(mutation);
  });
}

export function atomicWriteBufferSync(filePath: string, content: Buffer): void {
  atomicWriteSync(filePath, content.toString("base64"), "base64");
}

/**
 * Async variant of atomicWriteSync. Atomically writes content to a file
 * by writing to a temp file first, then renaming.
 */
export async function atomicWriteAsync(filePath: string, content: string, encoding: BufferEncoding = "utf-8"): Promise<void> {
  return withProjectionMutation(filePath, async () => {
    preserveManagedProjectionBeforeMutation(filePath, Buffer.from(content, encoding));
    const mutation = beginManagedProjectionMutation(filePath, "write", content, encoding);
    let managedApplyStarted = false;
    try {
      managedMutationBoundaryForTest?.("before-write", filePath);
      managedApplyStarted = mutation !== null;
      if (!applyManagedProjectionMutation(mutation)) {
        await atomicWriteAsyncWithOps(filePath, content, encoding, DEFAULT_ASYNC_OPS);
      }
      managedMutationBoundaryForTest?.("after-write", filePath);
    } catch (error) {
      if (managedApplyStarted) retainManagedProjectionMutation(mutation);
      else abortManagedProjectionMutation(mutation);
      throw error;
    }
    commitManagedProjectionMutation(mutation);
  });
}

export function removeProjectionFileSync(filePath: string): void {
  withProjectionMutationSync(filePath, () => {
    preserveManagedProjectionBeforeMutation(filePath, null);
    const mutation = beginManagedProjectionMutation(filePath, "remove", null, null);
    let managedApplyStarted = false;
    try {
      managedApplyStarted = mutation !== null;
      if (!applyManagedProjectionMutation(mutation) && existsSync(filePath)) unlinkSync(filePath);
      managedMutationBoundaryForTest?.("after-remove", filePath);
    } catch (error) {
      if (managedApplyStarted) retainManagedProjectionMutation(mutation);
      else abortManagedProjectionMutation(mutation);
      throw error;
    }
    commitManagedProjectionMutation(mutation);
  });
}

/**
 * Move a divergent managed artifact file into `quarantineDir/<stamp>/<name>`
 * before its database row is pruned, so the file's evidence survives the
 * repair (#2994). Returns the quarantine destination, or null when the file
 * is already gone. The move (not a copy+delete) keeps the operation atomic;
 * the destination keeps the original bytes under a reviewed-repair trail.
 */
export function moveProjectionFileToQuarantineSync(filePath: string, quarantineDir: string): string | null {
  if (!existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = join(quarantineDir, stamp, basename(filePath));
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = `${candidate}.${suffix}`;
    suffix += 1;
  }
  mkdirSync(dirname(candidate), { recursive: true });
  // Evidence lands before the original is removed: a failed removal leaves
  // the bytes in quarantine while the error aborts the caller's row prune.
  copyFileSync(filePath, candidate);
  // The original is removed through the journal-owned removal so an
  // interrupted earlier mutation on this path is recovered first — a bare
  // rename would strand its journal entry and wedge later managed writes.
  removeProjectionFileSync(filePath);
  return candidate;
}

export function removeProjectionTreeSync(directoryPath: string): void {
  withProjectionMutationSync(directoryPath, () => {
    const mutation = beginManagedProjectionMutation(directoryPath, "remove-tree", null, null);
    let managedApplyStarted = false;
    try {
      managedApplyStarted = mutation !== null;
      if (!applyManagedProjectionMutation(mutation)) {
        removeProjectionTreeWithoutDatabaseSync(directoryPath);
      }
    } catch (error) {
      if (managedApplyStarted) retainManagedProjectionMutation(mutation);
      else abortManagedProjectionMutation(mutation);
      throw error;
    }
    commitManagedProjectionMutation(mutation);
  });
}

function removeProjectionTreeWithoutDatabaseSync(directoryPath: string): void {
  const absolutePath = resolve(directoryPath);
  let gsdPath = dirname(absolutePath);
  while (gsdPath !== dirname(gsdPath) && basename(gsdPath).toLocaleLowerCase("en-US") !== ".gsd") {
    gsdPath = dirname(gsdPath);
  }
  if (basename(gsdPath).toLocaleLowerCase("en-US") === ".gsd") {
    const targetRoot = dirname(gsdPath);
    const logicalPath = relative(gsdPath, absolutePath).replaceAll("\\", "/");
    if (classifyGsdLogicalPath(logicalPath) === "managed" && !existsSync(join(gsdPath, "gsd.db"))) {
      removeLegacyProjectionTreeSync(targetRoot, absolutePath);
      return;
    }
  }

  const parentPath = dirname(absolutePath);
  const parentStat = lstatSync(parentPath, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("projection removal parent is not an identity-stable directory");
  }
  if (!isProjectionRootIdentityLockAvailable()) {
    // Plain-fs fallback: mirror the native path's contract — a missing target
    // is a no-op, non-directory or symlink targets are rejected, removal is
    // recursive for directory trees.
    let targetStat;
    try {
      targetStat = lstatSync(absolutePath, { bigint: true });
    } catch (error) {
      // Only a genuinely missing target is a no-op, matching the native path
      // (which returns early on `!handle.pathExists(name)`). Real errors like
      // EACCES/EPERM/ENOTDIR must surface rather than be masked.
      if (normalizeErrnoCode(error) === "ENOENT") return;
      throw error;
    }
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error("projection removal target is not a directory");
    }
    rmSync(absolutePath, { recursive: true, force: true });
    return;
  }
  const handle = acquireProjectionRootIdentityLock(
    realpathSync(parentPath),
    parentStat.dev.toString(),
    parentStat.ino.toString(),
  );
  try {
    const name = basename(absolutePath);
    if (!handle.pathExists(name)) return;
    if (handle.pathKind(name) !== "directory") throw new Error("projection removal target is not a directory");
    handle.removeTree(name);
  } finally {
    handle.close();
  }
}

export function copyProjectionTreeSync(
  sourcePath: string,
  directoryPath: string,
  include: (sourcePath: string) => boolean = () => true,
): void {
  if (existsSync(directoryPath)) removeProjectionTreeSync(directoryPath);
  transferProjectionTreeSync(sourcePath, directoryPath, true, include);
}

export function mergeProjectionTreeSync(
  sourcePath: string,
  directoryPath: string,
  overwrite: boolean,
): void {
  if (!existsSync(sourcePath)) return;
  transferProjectionTreeSync(sourcePath, directoryPath, overwrite, () => true);
}

const projectionStatIdentity = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;

function readStableProjectionSource(handle: ProjectionRootIdentityLock, logicalPath: string): Buffer {
  const identity = handle.pathIdentity(logicalPath);
  const first = handle.readFile(logicalPath);
  projectionCopyBoundaryForTest?.();
  const second = handle.readFile(logicalPath);
  if (handle.pathIdentity(logicalPath) !== identity
    || createHash("sha256").update(first).digest("hex") !== createHash("sha256").update(second).digest("hex")) {
    throw new Error("projection copy source changed during identity proof");
  }
  return first;
}

// Plain-fs source proof used when the native identity lock is unavailable
// (pinned engine binary predates ProjectionRootIdentityLock, or the addon
// failed to load). Mirrors readStableProjectionSource: double-read with a
// content hash plus a dev:ino identity comparison. Each read opens with
// O_NOFOLLOW (where the platform defines it) and both proves identity (via
// fstat on the resulting fd) and reads through that same fd, so a regular
// file to symlink swap racing the proof fails the open with ELOOP instead of
// following the link out of the source root, the plain-fs analogue of the
// native lock's AT_SYMLINK_NOFOLLOW reads.
//
// expectedParentIdentity is the dev:ino the caller already validated for the
// source's parent directory. The native lock pins the parent by dev:ino and
// reads relative to that fd, so a rename/symlink swap of the parent cannot
// redirect the read. Node has no openat, so the plain-fs analogue re-proves
// the parent's dev:ino (and that it is still a non-symlink directory) before
// every open: a parent swapped between the caller's check and this read then
// fails the proof instead of redirecting the open outside the source root.
function readStableProjectionSourceFallback(sourcePath: string, expectedParentIdentity: string): Buffer {
  const parentPath = dirname(sourcePath);
  const proveParent = (): void => {
    const parentStat = lstatSync(parentPath, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || projectionStatIdentity(parentStat) !== expectedParentIdentity) {
      throw new Error(`projection copy source parent identity changed during proof: ${sourcePath}`);
    }
  };
  const readNoFollow = (): { identity: string; content: Buffer } => {
    proveParent();
    const fd = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      // Defense for platforms/filesystems where O_NOFOLLOW is unavailable or a
      // no-op (constant 0, e.g. Windows): if the open silently followed a
      // symlink, the fd resolves to the link target while an lstat of the path
      // (which never follows) reports the link itself. Reject on any identity
      // mismatch, or on a non-regular opened node, so a regular file to symlink
      // swap cannot escape the source root even without O_NOFOLLOW enforcement.
      const onDisk = lstatSync(sourcePath, { bigint: true });
      if (!opened.isFile() || projectionStatIdentity(opened) !== projectionStatIdentity(onDisk)) {
        throw new Error(`projection copy source is not a regular file: ${sourcePath}`);
      }
      return { identity: projectionStatIdentity(opened), content: readFileSync(fd) };
    } finally {
      closeSync(fd);
    }
  };
  const first = readNoFollow();
  projectionCopyBoundaryForTest?.();
  const second = readNoFollow();
  if (first.identity !== second.identity
    || createHash("sha256").update(first.content).digest("hex") !== createHash("sha256").update(second.content).digest("hex")) {
    throw new Error("projection copy source changed during identity proof");
  }
  return first.content;
}

// Plain-fs tree transfer used when the native identity lock is unavailable.
// Preserves transferProjectionTreeSync semantics: existing non-directory
// targets are kept unless overwrite. Entry types are resolved with lstat (no
// symlink follow) so the decision is accurate even on filesystems whose
// readdir returns DT_UNKNOWN, and symlinks / other non-regular nodes are
// rejected rather than skipped, matching the native lock's pathKind, which
// throws on them. Failing loud avoids producing a silent partial projection
// that leaves worktree state subtly inconsistent, and a rejected symlink
// still cannot escape the source root.
function transferProjectionTreeFallbackSync(
  sourcePath: string,
  directoryPath: string,
  overwrite: boolean,
  include: (sourcePath: string) => boolean,
): void {
  function transferDirectory(sourceDir: string, target: string): void {
    if (!overwrite && existsSync(target) && !lstatSync(target).isDirectory()) return;
    createProjectionDirectorySync(target);
    // Pin this directory's identity so each per-entry read can re-prove its
    // parent (see readStableProjectionSourceFallback): a rename/symlink swap of
    // sourceDir between the readdir and a file read then fails the proof rather
    // than redirecting the read outside the source root.
    const sourceDirStat = lstatSync(sourceDir, { bigint: true });
    if (!sourceDirStat.isDirectory() || sourceDirStat.isSymbolicLink()) {
      throw new Error(`projection copy source directory is not identity-stable: ${sourceDir}`);
    }
    const sourceDirIdentity = projectionStatIdentity(sourceDirStat);
    for (const name of readdirSync(sourceDir)) {
      const sourceEntry = join(sourceDir, name);
      if (!include(sourceEntry)) continue;
      const targetEntry = join(target, name);
      const entryStat = lstatSync(sourceEntry);
      if (entryStat.isDirectory()) transferDirectory(sourceEntry, targetEntry);
      else if (!entryStat.isFile()) {
        throw new Error(`projection copy source entry is neither a regular file nor a directory: ${sourceEntry}`);
      } else if (overwrite || !existsSync(targetEntry)) {
        atomicWriteBufferSync(targetEntry, readStableProjectionSourceFallback(sourceEntry, sourceDirIdentity));
      }
    }
  }
  transferDirectory(sourcePath, directoryPath);
}

function transferProjectionTreeSync(
  sourcePath: string,
  directoryPath: string,
  overwrite: boolean,
  include: (sourcePath: string) => boolean,
): void {
  const stat = lstatSync(sourcePath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("projection copy source is not an identity-stable directory");
  }
  if (!isProjectionRootIdentityLockAvailable()) {
    transferProjectionTreeFallbackSync(sourcePath, directoryPath, overwrite, include);
    return;
  }
  const handle = acquireProjectionRootIdentityLock(realpathSync(sourcePath), stat.dev.toString(), stat.ino.toString());
  function transferDirectory(logicalDirectory: string, target: string): void {
    if (!overwrite && existsSync(target) && !lstatSync(target).isDirectory()) return;
    createProjectionDirectorySync(target);
    for (const name of handle.listDirectory(logicalDirectory)) {
      const logicalEntry = logicalDirectory.length === 0 ? name : `${logicalDirectory}/${name}`;
      const sourceEntry = join(sourcePath, logicalEntry);
      if (!include(sourceEntry)) continue;
      const targetEntry = join(target, name);
      const kind = handle.pathKind(logicalEntry);
      if (kind === "directory") transferDirectory(logicalEntry, targetEntry);
      else if (overwrite || !existsSync(targetEntry)) {
        atomicWriteBufferSync(targetEntry, readStableProjectionSource(handle, logicalEntry));
      }
    }
  }
  try {
    transferDirectory("", directoryPath);
  } finally {
    handle.close();
  }
}

export function copyProjectionFileSync(sourcePath: string, filePath: string, overwrite: boolean): void {
  if (!existsSync(sourcePath)) return;
  if (!overwrite && existsSync(filePath)) return;
  const parent = dirname(sourcePath);
  const parentStat = lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("projection copy source parent is not identity-stable");
  }
  if (!isProjectionRootIdentityLockAvailable()) {
    const fallbackStat = lstatSync(sourcePath);
    if (!fallbackStat.isFile() || fallbackStat.isSymbolicLink()) {
      throw new Error("projection copy source is not a regular file");
    }
    atomicWriteBufferSync(filePath, readStableProjectionSourceFallback(sourcePath, projectionStatIdentity(parentStat)));
    return;
  }
  const handle = acquireProjectionRootIdentityLock(realpathSync(parent), parentStat.dev.toString(), parentStat.ino.toString());
  const logicalPath = basename(sourcePath);
  const stat = lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    handle.close();
    throw new Error("projection copy source is not a regular file");
  }
  try {
    atomicWriteBufferSync(filePath, readStableProjectionSource(handle, logicalPath));
  } finally {
    handle.close();
  }
}

export function createProjectionDirectorySync(directoryPath: string): void {
  withProjectionMutationSync(directoryPath, () => {
    if (!createManagedProjectionDirectorySync(directoryPath)) {
      mkdirSync(directoryPath, { recursive: true });
    }
  });
}
