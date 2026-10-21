/**
 * GSD Session Lock — OS-level exclusive locking for auto-mode sessions.
 *
 * Prevents multiple GSD processes from running auto-mode concurrently on
 * the same project. Uses proper-lockfile for OS-level file locking (flock/
 * lockfile) which eliminates the TOCTOU race condition that existed with
 * the old advisory JSON lock approach.
 *
 * The lock file (.gsd/auto.lock) contains JSON metadata (PID, start time,
 * unit info) for diagnostics, but the actual exclusion is enforced by the
 * OS-level lock held via proper-lockfile.
 *
 * Lifecycle:
 *   acquireSessionLock()  — called at the START of bootstrapAutoSession
 *   validateSessionLock() — called periodically during dispatch to detect takeover
 *   releaseSessionLock()  — called on clean stop/pause
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { gsdRoot, normalizeRealPath } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import { markWorkerStoppingByPid } from "./db/auto-workers.js";
import { logWarning } from "./workflow-logger.js";

const _require = createRequire(import.meta.url);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionLockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  sessionFile?: string;
}

export type SessionLockResult =
  | { acquired: true; reentrant?: true }
  | { acquired: false; reason: string; existingPid?: number };

export type SessionLockFailureReason =
  | "compromised"
  | "missing-metadata"
  | "pid-mismatch";

export interface SessionLockStatus {
  valid: boolean;
  failureReason?: SessionLockFailureReason;
  existingPid?: number;
  expectedPid?: number;
  recovered?: boolean;
}

interface ProperLockfileApi {
  lockSync(
    path: string,
    options?: {
      realpath?: boolean;
      stale?: number;
      update?: number;
      onCompromised?: () => void;
    },
  ): () => void;
}

let _properLockfileOverride: ProperLockfileApi | undefined;

// ─── Module State ───────────────────────────────────────────────────────────

/** Release function from proper-lockfile — calling it releases the OS lock. */
let _releaseFunction: (() => void) | null = null;

/** The physical target we currently hold an OS lock on. */
let _lockedPath: string | null = null;

/** Canonical project/process lock identity, stable across .gsd migration. */
let _lockedOwner: string | null = null;

/** Our PID at lock acquisition time. */
let _lockPid: number = 0;

/** Set to true when proper-lockfile fires onCompromised (mtime drift, sleep, etc.). */
let _lockCompromised: boolean = false;

/** Whether we've already registered a process.on('exit') handler. */
let _exitHandlerRegistered: boolean = false;

/** Registry of all gsdDir paths where locks were created during this session.
 *  The exit handler cleans ALL of these, not just the current gsdRoot(). (#1578) */
const _lockDirRegistry: Set<string> = new Set();

/** Snapshotted lock file path — captured at acquireSessionLock time to avoid
 *  gsdRoot() resolving differently in worktree vs project root contexts (#1363). */
let _snapshotLockPath: string | null = null;

/** Timestamp when the session lock was acquired — used to detect false-positive
 *  onCompromised events from event loop stalls within the stale window (#1362). */
let _lockAcquiredAt: number = 0;

const LOCK_FILE = "auto.lock";

/**
 * Derive the effective lock file name for the current process.
 * In parallel worker mode (GSD_PARALLEL_WORKER + GSD_MILESTONE_LOCK),
 * each worker uses a per-milestone lock file (`auto-<milestoneId>.lock`)
 * to avoid contending on the shared `.gsd/auto.lock` (#2184).
 */
export function effectiveLockFile(): string {
  const mid = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : null;
  return mid ? `auto-${mid}.lock` : LOCK_FILE;
}

/**
 * Derive the OS-level lock target directory for the current process.
 * In parallel worker mode, uses `.gsd/parallel/<milestoneId>/` instead of
 * `.gsd/` so workers don't contend on the same proper-lockfile directory (#2184).
 */
export function effectiveLockTarget(gsdDir: string): string {
  const mid = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : null;
  return mid ? join(gsdDir, "parallel", mid) : gsdDir;
}

function lockPath(basePath: string): string {
  // If we have a snapshotted path from acquisition, use it for consistency
  if (_snapshotLockPath) return _snapshotLockPath;
  return join(gsdRoot(basePath), effectiveLockFile());
}

function canonicalLockTarget(basePath: string): string {
  return normalizeRealPath(effectiveLockTarget(gsdRoot(basePath)));
}

function canonicalLockOwner(basePath: string): string {
  return `${normalizeRealPath(basePath)}\0${effectiveLockFile()}`;
}

export interface LockDirectoryFs {
  rmSync(path: string, options: { recursive: boolean; force: true }): void;
  rmdirSync(path: string): void;
  existsSync(path: string): boolean;
}

const defaultLockDirectoryFs: LockDirectoryFs = { rmSync, rmdirSync, existsSync };

/**
 * Remove a proper-lockfile directory. Node `fs.rmSync({ recursive: true })` can
 * return without throwing while leaving the directory in place on Windows when
 * the absolute path contains non-ASCII characters. After rmSync, verify with
 * existsSync and fall back to rmdirSync; if the path still exists, throw with
 * the path so callers cannot treat a no-op as success. (#1526)
 */
export function removeLockDirectory(
  lockDir: string,
  fsOps: LockDirectoryFs = defaultLockDirectoryFs,
): void {
  if (!fsOps.existsSync(lockDir)) return;
  try {
    fsOps.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // rmSync may throw or silently no-op; rmdirSync is the known-working fallback.
  }
  if (!fsOps.existsSync(lockDir)) return;
  try {
    fsOps.rmdirSync(lockDir);
  } catch (error) {
    throw new Error(
      `Session lock directory still exists after rmSync/rmdirSync: ${lockDir}` +
        ` (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (fsOps.existsSync(lockDir)) {
    throw new Error(
      `Session lock directory still exists after rmSync/rmdirSync: ${lockDir}. ` +
        `Node fs.rmSync can no-op on Windows paths with non-ASCII characters. ` +
        `Remove it manually: rmdir "${lockDir}"`,
    );
  }
}

// ─── Stray Lock Cleanup ─────────────────────────────────────────────────────

/**
 * Remove numbered lock file variants (e.g. "auto 2.lock", "auto 3.lock")
 * that accumulate from macOS file conflict resolution (iCloud/Dropbox/OneDrive)
 * or other filesystem-level copy-on-conflict behavior (#1315).
 *
 * Also removes stray proper-lockfile directories beyond the canonical `.gsd.lock/`.
 */
export function cleanupStrayLockFiles(basePath: string): void {
  const gsdDir = gsdRoot(basePath);

  // Clean numbered auto lock files inside .gsd/
  try {
    if (existsSync(gsdDir)) {
      for (const entry of readdirSync(gsdDir)) {
        // Match "auto <N>.lock" or "auto (<N>).lock" variants but NOT the canonical "auto.lock"
        if (entry !== LOCK_FILE && /^auto\s.+\.lock$/i.test(entry)) {
          try { unlinkSync(join(gsdDir, entry)); } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal: directory read failure */ }

  // Clean stray proper-lockfile directories (e.g. ".gsd 2.lock/")
  // The canonical one is ".gsd.lock/" — anything else is stray.
  try {
    const parentDir = dirname(gsdDir);
    const gsdDirName = gsdDir.split("/").pop() || ".gsd";
    if (existsSync(parentDir)) {
      for (const entry of readdirSync(parentDir)) {
        // Match ".gsd <N>.lock" or ".gsd (<N>).lock" directories but NOT ".gsd.lock"
        if (entry !== `${gsdDirName}.lock` && entry.startsWith(gsdDirName) && entry.endsWith(".lock")) {
          const fullPath = join(parentDir, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              try { removeLockDirectory(fullPath); } catch { /* best-effort stray cleanup */ }
            }
          } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Register a single process exit handler that cleans up lock state.
 * Uses module-level references so it always operates on current state.
 * Only registers once — subsequent calls are no-ops.
 */
function ensureExitHandler(_gsdDir: string): void {
  // Register the gsdDir so exit cleanup covers it
  _lockDirRegistry.add(_gsdDir);

  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;

  process.once("exit", () => {
    try {
      if (_releaseFunction) { _releaseFunction(); _releaseFunction = null; }
    } catch { /* best-effort */ }
    // Clean ALL registered lock paths, not just the current one (#1578).
    // Lock files accumulate across main project .gsd/, worktree .gsd/,
    // and projects registry paths — cleanup must cover all of them.
    for (const dir of _lockDirRegistry) {
      const lockFile = join(dir, LOCK_FILE);
      const ownsRegisteredLock = isLockFileOwnedByCurrentProcess(lockFile);
      try {
        if (ownsRegisteredLock && existsSync(lockFile)) unlinkSync(lockFile);
      } catch { /* best-effort */ }
      try {
        const lockDir = join(dir + ".lock");
        if (ownsRegisteredLock) removeLockDirectory(lockDir);
      } catch { /* best-effort on process exit */ }
    }
  });
}

// ─── Lock Acquisition Helpers ───────────────────────────────────────────────

/**
 * Create the onCompromised callback for proper-lockfile.
 *
 * proper-lockfile fires onCompromised when it detects mtime drift (system sleep,
 * event loop stall, etc.). The default handler throws inside setTimeout — an
 * uncaught exception that crashes or corrupts process state.
 *
 * False-positive suppression (#1362): If we're still within the stale window
 * (30 min since acquisition), the mtime mismatch is from an event loop stall
 * during a long LLM call — not a real takeover. Log and continue.
 *
 * PID ownership check (#1578): Past the stale window, check if the lock file
 * still contains our PID before declaring compromise. Retry reads tolerate
 * transient filesystem hiccups (NFS/CIFS latency, APFS snapshots, etc.) (#2324).
 */
function createLockCompromisedHandler(lockFilePath: string): () => void {
  return () => {
    const elapsed = Date.now() - _lockAcquiredAt;
    if (elapsed < 1_800_000) {
      logWarning(
        "session",
        `Lock heartbeat caught up after ${Math.round(elapsed / 1000)}s — long LLM call, no action needed.`,
      );
      return;
    }
    const existing = readExistingLockDataWithRetry(lockFilePath);
    if (existing && existing.pid === process.pid) {
      logWarning(
        "session",
        `Lock heartbeat mismatch after ${Math.round(elapsed / 1000)}s — lock file still owned by PID ${process.pid}, treating as false positive.`,
      );
      return;
    }
    _lockCompromised = true;
    _releaseFunction = null;
  };
}

/**
 * Assign module-level lock state after a successful lock acquisition.
 */
function assignLockState(
  lockOwner: string,
  lockTarget: string,
  release: () => void,
  lockFilePath: string,
): void {
  _releaseFunction = release;
  _lockedOwner = lockOwner;
  _lockedPath = lockTarget;
  _lockPid = process.pid;
  _lockCompromised = false;
  _lockAcquiredAt = Date.now();
  _snapshotLockPath = lockFilePath;
}

/**
 * Replace a compromised lock without running stale-lock cleanup. A successful
 * exclusive lockSync is the proof that the previous OS lock is no longer held.
 */
function recoverCompromisedLock(
  basePath: string,
  lockFilePath: string,
  lockData: SessionLockData,
): boolean {
  let lockfile: ProperLockfileApi;
  try {
    lockfile = _properLockfileOverride ?? _require("proper-lockfile") as ProperLockfileApi;
  } catch {
    return false;
  }

  const lockTarget = canonicalLockTarget(basePath);
  try {
    const release = lockfile.lockSync(lockTarget, {
      realpath: false,
      stale: 1_800_000,
      update: 10_000,
      onCompromised: createLockCompromisedHandler(lockFilePath),
    });
    try {
      atomicWriteSync(lockFilePath, JSON.stringify(lockData, null, 2));
    } catch {
      try { release(); } catch { /* best-effort */ }
      return false;
    }
    assignLockState(canonicalLockOwner(basePath), lockTarget, release, lockFilePath);
    ensureExitHandler(lockTarget);
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Attempt to acquire an exclusive session lock for the given project.
 *
 * This uses proper-lockfile for OS-level file locking. If another process
 * already holds the lock, this returns { acquired: false } with details.
 *
 * The lock file also contains JSON metadata about the session for
 * diagnostic purposes (PID, unit info, etc.).
 */
export function acquireSessionLock(basePath: string): SessionLockResult {
  const lp = lockPath(basePath);

  // Ensure the directory exists before canonicalizing the lock target.
  mkdirSync(dirname(lp), { recursive: true });

  const lockTarget = canonicalLockTarget(basePath);
  const lockOwner = canonicalLockOwner(basePath);
  const lockData: SessionLockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
  };

  // A healthy same-process re-entry already owns the OS lock. Keep that lock
  // continuously held and only refresh its informational metadata.
  if (_releaseFunction && !_lockCompromised && _lockedOwner === lockOwner) {
    if (_lockedPath === lockTarget) {
      atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
      return { acquired: true, reentrant: true };
    }

    // External-state migration can replace <project>/.gsd with a symlink while
    // bootstrap already owns the original target. Acquire the new physical
    // target before releasing the old one so exclusion remains continuous.
    let lockfile: ProperLockfileApi;
    try {
      lockfile = _properLockfileOverride ?? _require("proper-lockfile") as ProperLockfileApi;
    } catch {
      _lockedPath = lockTarget;
      atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
      return { acquired: true, reentrant: true };
    }

    try {
      mkdirSync(lockTarget, { recursive: true });
      const previousRelease = _releaseFunction;
      const release = lockfile.lockSync(lockTarget, {
        realpath: false,
        stale: 1_800_000,
        update: 10_000,
        onCompromised: createLockCompromisedHandler(lp),
      });
      try {
        atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
      } catch (error) {
        try { release(); } catch { /* best-effort */ }
        throw error;
      }
      assignLockState(lockOwner, lockTarget, release, lp);
      ensureExitHandler(lockTarget);
      try { previousRelease(); } catch { /* best-effort: new target is already held */ }
      return { acquired: true, reentrant: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        acquired: false,
        reason: `Could not transfer session lock after state-path migration: ${detail}`,
      };
    }
  }

  // Clean up numbered lock file variants from cloud sync conflicts (#1315)
  cleanupStrayLockFiles(basePath);

  // If lock metadata points to a dead PID, mark that worker row stopping so
  // crash diagnostics do not keep surfacing it as active.
  const existingPreflight = readExistingLockData(lp);
  if (existingPreflight?.pid && !isPidAlive(existingPreflight.pid)) {
    markWorkerStoppingByPid(normalizeRealPath(basePath), existingPreflight.pid);
  }

  let lockfile: ProperLockfileApi;
  try {
    lockfile = _properLockfileOverride ?? _require("proper-lockfile") as ProperLockfileApi;
  } catch {
    // proper-lockfile not available — fall back to PID-based check
    return acquireFallbackLock(basePath, lp, lockData);
  }

  // #3218: Pre-flight stale lock cleanup — if the .lock/ directory exists but
  // no auto.lock metadata is present (or the PID is dead), remove the lock
  // directory before attempting acquisition. This prevents the 30-min stale
  // window from blocking /gsd after crashes, SIGKILL, or laptop sleep.
  const lockDir = lockTarget + ".lock";
  if (existsSync(lockDir)) {
    const existingData = readExistingLockData(lp);
    const deadPid = existingData?.pid && !isPidAlive(existingData.pid) ? existingData.pid : null;
    if (deadPid) markWorkerStoppingByPid(normalizeRealPath(basePath), deadPid);
    const isOrphan = !existingData || !!deadPid;
    if (isOrphan) {
      try {
        removeLockDirectory(lockDir);
      } catch (error) {
        return {
          acquired: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      try { if (existsSync(lp)) unlinkSync(lp); } catch { /* best-effort */ }
    }
  }

  try {
    // Try to acquire an exclusive OS-level lock on the lock target.
    // We lock a directory since proper-lockfile works best on directories,
    // and the lock file itself may not exist yet.
    // In parallel worker mode, lockTarget is .gsd/parallel/<MID>/ (#2184).
    mkdirSync(lockTarget, { recursive: true });

    const release = lockfile.lockSync(lockTarget, {
      realpath: false,
      stale: 1_800_000, // 30 minutes — safe for laptop sleep / long event loop stalls
      update: 10_000, // Update lock mtime every 10s to prove liveness
      onCompromised: createLockCompromisedHandler(lp),
    });

    assignLockState(lockOwner, lockTarget, release, lp);

    // Safety net: clean up lock dir on process exit if _releaseFunction
    // wasn't called (e.g., normal exit after clean completion) (#1245).
    ensureExitHandler(lockTarget);

    // Write the informational lock data
    atomicWriteSync(lp, JSON.stringify(lockData, null, 2));

    return { acquired: true };
  } catch (err) {
    // Lock is held by another process — or the .gsd.lock/ directory is stranded.
    // Check: if auto.lock is gone and no process is alive, the lock dir is stale.
    const existingData = readExistingLockData(lp);
    const existingPid = existingData?.pid;
    if (existingPid && !isPidAlive(existingPid)) {
      markWorkerStoppingByPid(normalizeRealPath(basePath), existingPid);
    }

    // If no lock file or no alive process, try to clean up and re-acquire (#1245)
    if (!existingData || (existingPid && !isPidAlive(existingPid))) {
      try {
        const lockDir = join(lockTarget + ".lock");
        removeLockDirectory(lockDir);
        if (existsSync(lp)) unlinkSync(lp);

        // Retry acquisition after cleanup
        const release = lockfile.lockSync(lockTarget, {
          realpath: false,
          stale: 1_800_000, // 30 minutes — match primary lock settings
          update: 10_000,
          onCompromised: createLockCompromisedHandler(lp),
        });
        assignLockState(lockOwner, lockTarget, release, lp);

        // Safety net — uses centralized handler to avoid double-registration
        ensureExitHandler(lockTarget);

        atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
        return { acquired: true };
      } catch (retryErr) {
        if (retryErr instanceof Error && retryErr.message.includes("Session lock directory still exists")) {
          return { acquired: false, reason: retryErr.message };
        }
        // Retry also failed — fall through to the error path
      }
    }

    // #3218: Provide actionable workaround when lock recovery fails
    const lockDirPath = lockTarget + ".lock";
    const reason = existingPid
      ? `Another auto-mode session (PID ${existingPid}) appears to be running.\nRun \`/gsd stop\` for graceful shutdown, or choose "Force start" from \`/gsd auto\` to terminate it.`
      : `Another auto-mode session lock is stuck on this project.\nRun: rm -rf "${lockDirPath}" && rm -f "${lp}"`;

    return { acquired: false, reason, existingPid };
  }
}

/**
 * Fallback lock acquisition when proper-lockfile is not available.
 * Uses PID-based liveness checking (the old approach, but with the lock
 * written BEFORE initialization rather than after).
 */
function acquireFallbackLock(
  basePath: string,
  lp: string,
  lockData: SessionLockData,
): SessionLockResult {
  const lockTarget = canonicalLockTarget(basePath);
  const lockOwner = canonicalLockOwner(basePath);
  // Check if an existing lock is held by a live process
  const existing = readExistingLockData(lp);
  if (
    _lockedOwner === lockOwner &&
    _lockPid === process.pid &&
    existing?.pid === process.pid
  ) {
    _lockedPath = lockTarget;
    atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
    return { acquired: true, reentrant: true };
  }
  if (existing && existing.pid !== process.pid) {
    if (isPidAlive(existing.pid)) {
      return {
        acquired: false,
        reason: `Another auto-mode session (PID ${existing.pid}) is already running on this project.`,
        existingPid: existing.pid,
      };
    }
    // Stale lock from dead process — we can take over
  }

  // Write our lock data
  atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
  _lockedOwner = lockOwner;
  _lockedPath = lockTarget;
  _lockPid = process.pid;

  return { acquired: true };
}

/**
 * Update the lock file metadata (called on each unit dispatch).
 * Does NOT re-acquire the OS lock — just updates the JSON content.
 */
export function updateSessionLock(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  if (_lockedOwner !== canonicalLockOwner(basePath) && _lockedOwner !== null) return;

  const lp = lockPath(basePath);
  try {
    const data: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      sessionFile,
    };
    atomicWriteSync(lp, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal: lock update failure
  }
}

/**
 * Validate that we still own the session lock.
 *
 * Returns true if we still hold the lock, false if another process
 * has taken over (indicating we should gracefully stop).
 *
 * This is called periodically during the dispatch loop.
 */
export function getSessionLockStatus(basePath: string): SessionLockStatus {
  // Lock was compromised by proper-lockfile (mtime drift from sleep, stall, etc.)
  if (_lockCompromised) {
    // Recovery gate (#1512): Before declaring the lock lost, check if the lock
    // file still contains our PID. If it does, no other process took over — the
    // onCompromised fired from benign mtime drift (laptop sleep, event loop stall
    // beyond the stale window). Attempt re-acquisition instead of giving up.
    const lp = lockPath(basePath);
    // Retry reads to tolerate transient filesystem hiccups (#2324).
    const existing = readExistingLockDataWithRetry(lp);
    if (existing && existing.pid === process.pid) {
      if (recoverCompromisedLock(basePath, lp, existing)) {
        logWarning("session", "Lock recovered after onCompromised — lock file PID matched, re-acquired.");
        return { valid: true, recovered: true };
      }
    }
    return {
      valid: false,
      failureReason: "compromised",
      existingPid: existing?.pid,
      expectedPid: process.pid,
    };
  }

  // If we have an OS-level lock, we're still the owner
  if (
    _releaseFunction &&
    _lockedOwner === canonicalLockOwner(basePath) &&
    _lockedPath === canonicalLockTarget(basePath)
  ) {
    return { valid: true };
  }

  // Fallback: check the lock file PID
  const lp = lockPath(basePath);
  const existing = readExistingLockData(lp);
  if (!existing) {
    // Lock file was deleted — we lost ownership
    return {
      valid: false,
      failureReason: "missing-metadata",
      expectedPid: process.pid,
    };
  }

  if (existing.pid !== process.pid) {
    return {
      valid: false,
      failureReason: "pid-mismatch",
      existingPid: existing.pid,
      expectedPid: process.pid,
    };
  }

  return { valid: true };
}

export function validateSessionLock(basePath: string): boolean {
  return getSessionLockStatus(basePath).valid;
}

/**
 * Release the session lock. Called on clean stop/pause.
 */
export function releaseSessionLock(basePath: string): void {
  // Release the OS-level lock
  if (_releaseFunction) {
    try {
      _releaseFunction();
    } catch {
      // Lock may already be released
    }
    _releaseFunction = null;
  }

  // Remove the lock file at the current path only if it still belongs to us.
  // Lost-lock cleanup can run after another process has taken ownership; in
  // that case deleting auto.lock would erase the newer owner's evidence.
  const lp = lockPath(basePath);
  const ownsPrimaryLock = isLockFileOwnedByCurrentProcess(lp);
  try {
    if (ownsPrimaryLock && existsSync(lp)) unlinkSync(lp);
  } catch {
    // Non-fatal
  }

  // Remove the proper-lockfile directory for the current lock target.
  // In parallel worker mode, this is .gsd/parallel/<MID>.lock/ (#2184).
  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);
  if (ownsPrimaryLock) {
    removeLockDirectory(join(lockTarget + ".lock"));
  }
  // Also clean the per-milestone parallel directory itself if it exists
  if (ownsPrimaryLock && lockTarget !== gsdDir) {
    try {
      if (existsSync(lockTarget)) rmSync(lockTarget, { recursive: true, force: true });
    } catch {
      // Non-fatal
    }
  }

  // Clean ALL registered lock paths (#1578) — lock files accumulate across
  // main project .gsd/, worktree .gsd/, and projects registry paths.
  for (const dir of _lockDirRegistry) {
    const lockFile = join(dir, LOCK_FILE);
    const ownsRegisteredLock = isLockFileOwnedByCurrentProcess(lockFile);
    try {
      if (ownsRegisteredLock && existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* best-effort */ }
    try {
      const lockDir = join(dir + ".lock");
      if (ownsRegisteredLock) removeLockDirectory(lockDir);
    } catch { /* best-effort registry cleanup */ }
  }
  _lockDirRegistry.clear();

  // Clean up numbered lock file variants from cloud sync conflicts (#1315)
  cleanupStrayLockFiles(basePath);

  _lockedPath = null;
  _lockedOwner = null;
  _lockPid = 0;
  _lockCompromised = false;
  _lockAcquiredAt = 0;
  _snapshotLockPath = null;
}

/**
 * Check if a session lock exists and return its data (for crash recovery).
 * Does NOT acquire the lock.
 */
export function readSessionLockData(basePath: string): SessionLockData | null {
  return readExistingLockData(lockPath(basePath));
}

/**
 * Check if the process that wrote the lock is still alive.
 */
export function isSessionLockProcessAlive(data: SessionLockData): boolean {
  return isPidAlive(data.pid);
}

/**
 * ADR-017 raw primitive: remove orphaned lock artifacts (lock dir + lock file)
 * when the recorded PID is dead or no metadata is present. Mirrors the
 * pre-flight cleanup logic in acquireSessionLock so the stale-worker drift
 * handler can clear the orphan proactively without going through the full
 * acquire path. No-op when the lock is held by an alive process.
 *
 * Returns true when artifacts were removed (drift was present).
 */
export function removeStaleSessionLock(basePath: string): boolean {
  const lp = lockPath(basePath);
  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);
  const lockDir = lockTarget + ".lock";

  const existingData = readExistingLockData(lp);
  const isOrphan =
    !existingData ||
    (typeof existingData.pid === "number" && !isPidAlive(existingData.pid));
  if (!isOrphan) return false;

  let removed = false;
  if (existsSync(lockDir)) {
    removeLockDirectory(lockDir);
    removed = true;
  }
  if (existsSync(lp)) {
    try {
      unlinkSync(lp);
      removed = true;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/**
 * Returns true if we currently hold a session lock for the given path.
 */
export function isSessionLockHeld(basePath: string): boolean {
  return (
    _lockedOwner === canonicalLockOwner(basePath) &&
    _lockedPath === canonicalLockTarget(basePath) &&
    _lockPid === process.pid
  );
}

/**
 * Returns a snapshot of the registered lock directory paths for diagnostics.
 * Exported for tests only.
 */
export function _getRegisteredLockDirs(): string[] {
  return [..._lockDirRegistry];
}

/** Override proper-lockfile for deterministic lock lifecycle tests. */
export function _setProperLockfileForTests(lockfile: ProperLockfileApi | undefined): () => void {
  const previous = _properLockfileOverride;
  _properLockfileOverride = lockfile;
  return () => { _properLockfileOverride = previous; };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function readExistingLockData(lp: string): SessionLockData | null {
  try {
    if (!existsSync(lp)) return null;
    const raw = readFileSync(lp, "utf-8");
    return JSON.parse(raw) as SessionLockData;
  } catch {
    return null;
  }
}

function isLockFileOwnedByCurrentProcess(lp: string): boolean {
  const existing = readExistingLockData(lp);
  return existing?.pid === process.pid;
}

/**
 * Retry-tolerant variant of readExistingLockData for use in onCompromised and
 * other paths where a transient filesystem hiccup (NFS/CIFS latency, macOS APFS
 * snapshot, concurrent process briefly holding the file) should NOT be treated
 * as "lock file gone" (#2324).
 *
 * Retries up to `maxAttempts` times with `delayMs` between each attempt.
 * Only returns null when ALL retries fail to read valid data.
 */
export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

const _retrySleepView = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  Atomics.wait(_retrySleepView, 0, 0, ms);
}

export function readExistingLockDataWithRetry(
  lp: string,
  options?: RetryOptions,
): SessionLockData | null {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = readExistingLockData(lp);
    if (data !== null) return data;
    if (attempt < maxAttempts) {
      sleepSync(delayMs);
    }
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}
