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

// Health latch (#2355): on Windows, delete-pending names can make
// ProjectionRootIdentityLock operations fail deterministically with
// ERROR_SHARING_VIOLATION (os error 32) — typically the publication step
// (exchange/publish/rename) while earlier prepare/read steps succeed. The
// addon's internal retry budget never recovers from that shape, and consumers
// keep routing writes through the failing native layer, stranding staging
// files and wedging projection renders. After repeated consecutive transient
// failures the wrapper reports the lock as unavailable, so every
// isProjectionRootIdentityLockAvailable() gate degrades to its existing
// plain-fs fallback (the same paths used when the addon is absent). The
// counter clears only when the previously failing operation itself succeeds —
// a success of a different operation (e.g. a prepare between two failing
// publishes) does not demonstrate the failing family recovered. While
// latched, the cool-off lets the gate re-probe after a quiet period; a
// success of the failing operation also clears the latch immediately. Only
// the transient sharing-violation family feeds the latch — deterministic
// protocol contradictions and permission failures keep their existing
// fail-closed semantics.
const PROJECTION_LOCK_LATCH_THRESHOLD = 3;
const PROJECTION_LOCK_LATCH_COOLOFF_MS = 60_000;
const PROJECTION_LOCK_OPEN_OP = "open";

let consecutiveTransientLockFailures = 0;
let lastTransientLockFailureOp: string | null = null;
let latchCooldownUntil = 0;
let latchClock: () => number = () => Date.now();

// Mirror of the extension-side transient families (projection-root-errors.ts,
// managed-projection-history.ts): EBUSY errno or the Windows sharing-violation
// wordings, matched through the cause chain because both the acquire wrapper
// and the addon wrap the raw N-API error. Native failure messages embed the
// full operation pathname, so only the diagnostic tail after the last ": "
// separator may classify — path text (e.g. a directory literally named
// "EBUSY") must never feed the latch.
function isTransientProjectionRootLockFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "EBUSY") return true;
    if (typeof candidate.message === "string") {
      const diagnosticTail = candidate.message.split(": ").pop() ?? "";
      if (/sharing violation|os error 32|projection root is busy|\bEBUSY\b/iu.test(diagnosticTail)) {
        return true;
      }
    }
    current = candidate.cause;
  }
  return false;
}

function recordProjectionRootLockSuccess(operation: string): void {
  if (lastTransientLockFailureOp !== operation) return;
  // The previously failing operation just succeeded: the native layer
  // demonstrably recovered, so the counter and any active latch clear.
  consecutiveTransientLockFailures = 0;
  lastTransientLockFailureOp = null;
  latchCooldownUntil = 0;
}

function recordProjectionRootLockFailure(operation: string, error: unknown): void {
  if (!isTransientProjectionRootLockFailure(error)) return;
  consecutiveTransientLockFailures += 1;
  lastTransientLockFailureOp = operation;
  if (consecutiveTransientLockFailures >= PROJECTION_LOCK_LATCH_THRESHOLD) {
    latchCooldownUntil = latchClock() + PROJECTION_LOCK_LATCH_COOLOFF_MS;
  }
}

function isProjectionRootIdentityLockLatched(): boolean {
  return latchCooldownUntil !== 0 && latchClock() < latchCooldownUntil;
}

/** @internal Exported for latch tests. */
export function _resetProjectionRootIdentityLockHealthForTest(): void {
  consecutiveTransientLockFailures = 0;
  lastTransientLockFailureOp = null;
  latchCooldownUntil = 0;
}

/** @internal Exported for latch tests. */
export function _setProjectionRootIdentityLockClockForTest(clock: (() => number) | null): void {
  latchClock = clock ?? (() => Date.now());
}

// Records the health outcome of every handle operation so the latch reflects
// real native behavior rather than construction alone. close() is excluded:
// it runs in finally blocks after failures and must not mask them (or count
// as recovery of the failing operation).
function trackProjectionRootIdentityLockHealth(
  handle: ProjectionRootIdentityLock,
): ProjectionRootIdentityLock {
  return new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (property === "close") return (value as (...args: unknown[]) => unknown).bind(target);
      const operation = String(property);
      return (...args: unknown[]) => {
        try {
          const result = (value as (...args: unknown[]) => unknown).apply(target, args);
          recordProjectionRootLockSuccess(operation);
          return result;
        } catch (error) {
          recordProjectionRootLockFailure(operation, error);
          throw error;
        }
      };
    },
  });
}

export function isProjectionRootIdentityLockAvailable(): boolean {
  if (!isNativeAddonLoaded() || typeof native.ProjectionRootIdentityLock !== "function") return false;
  return !isProjectionRootIdentityLockLatched();
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
  // See acquireSqliteFileIdentityLock: detect the throw-on-call proxy via the
  // load state, not just typeof, so the failure reads "unavailable". The latch
  // makes the same guard fire while the native layer is reportably unhealthy,
  // which is what sends gated consumers to their plain-fs fallbacks.
  if (!isProjectionRootIdentityLockAvailable()) throw new Error("native projection root identity locking is unavailable");
  const Lock = native.ProjectionRootIdentityLock;
  try {
    const handle = new Lock(path, expectedDevice, expectedInode);
    // A successful open recovers a prior failing-open streak (the same-op
    // guard leaves any other operation's failure streak untouched).
    recordProjectionRootLockSuccess(PROJECTION_LOCK_OPEN_OP);
    return trackProjectionRootIdentityLockHealth(handle);
  } catch (error) {
    // Record before the wrap so the latch classifier sees the raw native
    // error, not this wrapper's generic message.
    recordProjectionRootLockFailure(PROJECTION_LOCK_OPEN_OP, error);
    throw new Error("native projection root identity locking failed", { cause: error });
  }
}
