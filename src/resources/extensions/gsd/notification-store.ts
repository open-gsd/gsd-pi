// GSD Extension — Persistent Notification Store
// Captures all ctx.ui.notify() calls and workflow-logger warnings to
// .gsd/notifications.jsonl so they survive context resets and session restarts.
// Rotates at MAX_ENTRIES to prevent unbounded growth.

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export type NotifySeverity = "info" | "success" | "warning" | "error";
export type NotificationSource = "notify" | "workflow-logger";

/**
 * Optional structured identity for a notification. When present, `kind`
 * (a stable machine name like "auto-stop" or "provider-error-pause") plus
 * `scope` (e.g. a milestone/slice id) — not the prose — key deduplication,
 * and consumers can filter without parsing message text.
 */
export interface NotificationMeta {
  kind?: string;
  scope?: string;
  /**
   * Stable occurrence identity supplied by an adopted producer (#2935). When
   * present it is the ONLY dedup key: same occurrence collapses, a distinct
   * occurrence with the same kind and scope is never suppressed, and the
   * time window does not apply. Absent => prior behaviour unchanged.
   */
  occurrence?: Record<string, string | number>;
}

export interface NotificationEntry {
  id: string;
  ts: string;
  severity: NotifySeverity;
  message: string;
  source: NotificationSource;
  read: boolean;
  kind?: string;
  scope?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
const FILENAME = "notifications.jsonl";
const LOCKFILE = "notifications.lock";
const DEDUP_WINDOW_MS = 30_000;
const DEDUP_PRUNE_THRESHOLD = 200;

// ─── Module State ───────────────────────────────────────────────────────

let _basePath: string | null = null;
let _lineCount = 0;  // Hint for rotation — not authoritative for public API
let _suppressCount = 0;
let _recentMessageTimestamps = new Map<string, number>();
/**
 * Occurrence identities seen in this process (#2935). Deliberately separate from
 * the 30-second TTL map: an occurrence is not a time window, so it must not be
 * pruned by age. Bounded by a hard cap with FIFO eviction; eviction is the only
 * forgetting rule and is documented, not time-based.
 */
const OCCURRENCE_CAP = 256;
let _occurrenceSeen = new Set<string>();
const _changeListeners = new Set<() => void>();

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize the notification store. Call once at session start with the
 * project root. Seeds in-memory counters from the existing file on disk.
 */
export function initNotificationStore(basePath: string): void {
  if (_basePath !== basePath) {
    _recentMessageTimestamps.clear();
    _occurrenceSeen = new Set();
  }
  _basePath = basePath;
  // Seed line count hint for rotation — public counters read from disk
  _lineCount = _readEntriesFromDisk(basePath).length;
}

/**
 * Append a notification entry to the store. Synchronous — safe to call
 * from the notify() shim which is declared void (not async).
 */
export function appendNotification(
  message: string,
  severity: NotifySeverity,
  source: NotificationSource = "notify",
  meta?: NotificationMeta,
): void {
  if (!_basePath) return;
  if (_suppressCount > 0) return;
  const persistedMessage = message.length > 500 ? message.slice(0, 500) + "…" : message;
  if (meta?.occurrence) {
    // Adopted producer (#2935): dedup on the canonical occurrence tuple only.
    // Canonical JSON with sorted keys, so no delimiter collisions. No time window.
    const occKey = JSON.stringify(
      Object.keys(meta.occurrence).sort().map((k) => [k, meta.occurrence?.[k]]),
    );
    const occDedupKey = `${_basePath}:${severity}:${source}:occ:${occKey}`;
    if (_occurrenceSeen.has(occDedupKey)) return;
    _occurrenceSeen.add(occDedupKey);
    if (_occurrenceSeen.size > OCCURRENCE_CAP) {
      // FIFO: a Set iterates in insertion order, so the first key is the oldest.
      _occurrenceSeen.delete(_occurrenceSeen.values().next().value as string);
    }
    // Occurrence path is complete: the occurrence-keyed entry is persisted below
    // by the shared entry-building code, so fall through to it without the
    // time-window logic.
  } else {
    const identity = meta?.kind ? `${meta.kind}:${meta.scope ?? ""}` : persistedMessage;
    const dedupKey = `${_basePath}:${severity}:${source}:${identity}`;
    const now = Date.now();
    const lastSeen = _recentMessageTimestamps.get(dedupKey);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_WINDOW_MS) return;
    _recentMessageTimestamps.set(dedupKey, now);
    if (_recentMessageTimestamps.size > DEDUP_PRUNE_THRESHOLD) {
      for (const [key, ts] of _recentMessageTimestamps) {
        if (now - ts > DEDUP_WINDOW_MS) _recentMessageTimestamps.delete(key);
      }
    }
  }

  const entry: NotificationEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    severity,
    message: persistedMessage,
    source,
    read: false,
    ...(meta?.kind ? { kind: meta.kind } : {}),
    ...(meta?.scope ? { scope: meta.scope } : {}),
  };

  try {
    const dir = join(_basePath, ".gsd");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, FILENAME), JSON.stringify(entry) + "\n", "utf-8");
    _lineCount++;

    // Rotate if hint suggests we're over limit
    if (_lineCount > MAX_ENTRIES) {
      _rotate();
    }
    _emitChange();
  } catch {
    // Non-fatal — never let persistence break the caller
  }
}

/**
 * Read all notification entries from disk. Returns newest-first.
 * An optional filter narrows by structured identity (kind and/or scope).
 */
export function readNotifications(basePath?: string, filter?: NotificationMeta): NotificationEntry[] {
  const bp = basePath ?? _basePath;
  if (!bp) return [];
  const entries = _readEntriesFromDisk(bp).filter(
    (e) => (!filter?.kind || e.kind === filter.kind) && (!filter?.scope || e.scope === filter.scope),
  );
  return entries.reverse();
}

/**
 * Mark all notifications as read. Atomic rewrite via temp-file + rename.
 * Resyncs in-memory counters from disk after mutation.
 */
export function markAllRead(basePath?: string): void {
  const bp = basePath ?? _basePath;
  if (!bp) return;

  const entries = _readEntriesFromDisk(bp);
  if (entries.length === 0) return;

  const hasUnread = entries.some((e) => !e.read);
  if (!hasUnread) return;

  let changed = false;
  try {
    _withLock(bp, () => {
      // Re-read inside lock to get freshest state
      const fresh = _readEntriesFromDisk(bp);
      if (fresh.length === 0 || !fresh.some((e) => !e.read)) return;
      const lines = fresh.map((e) => JSON.stringify({ ...e, read: true }));
      _atomicWrite(bp, lines.join("\n") + "\n");
      changed = true;
    });
  } catch {
    // Non-fatal
  }
  if (changed) _emitChange();
}

/**
 * Clear all notifications. Atomic write of empty content under lock.
 */
export function clearNotifications(basePath?: string): void {
  const bp = basePath ?? _basePath;
  if (!bp) return;

  try {
    _withLock(bp, () => {
      _atomicWrite(bp, "");
    });
    _lineCount = 0;
    _occurrenceSeen = new Set();
    _emitChange();
  } catch {
    // Non-fatal
  }
}

/**
 * Get the current unread count. Reads from disk to stay accurate across
 * processes (web subprocess can clear/modify the file independently).
 */
export function getUnreadCount(): number {
  if (!_basePath) return 0;
  try {
    const entries = _readEntriesFromDisk(_basePath);
    return entries.filter((e) => !e.read).length;
  } catch {
    return 0;
  }
}

/**
 * Get the total notification count. Reads from disk for cross-process accuracy.
 */
export function getLineCount(): number {
  if (!_basePath) return 0;
  try {
    return _readEntriesFromDisk(_basePath).length;
  } catch {
    return 0;
  }
}

/**
 * Temporarily suppress persistence. Use around ctx.ui.notify calls that
 * should NOT be persisted (e.g., confirmation toasts after clear).
 * Calls are ref-counted — nest safely.
 */
export function suppressPersistence(): void {
  _suppressCount++;
}

export function unsuppressPersistence(): void {
  _suppressCount = Math.max(0, _suppressCount - 1);
}

/**
 * Subscribe to notification-store mutations (append, mark-read, clear).
 * Returns an unsubscribe function.
 */
export function onNotificationStoreChange(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => {
    _changeListeners.delete(listener);
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────

/**
 * Reset module state. Only for use in tests.
 */
export function _resetNotificationStore(): void {
  _basePath = null;
  _lineCount = 0;
  _suppressCount = 0;
  _recentMessageTimestamps = new Map();
  _occurrenceSeen = new Set();
  _changeListeners.clear();
}

// ─── Internal ───────────────────────────────────────────────────────────

function _readEntriesFromDisk(basePath: string): NotificationEntry[] {
  const filePath = join(basePath, ".gsd", FILENAME);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as NotificationEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is NotificationEntry => e !== null);
  } catch {
    return [];
  }
}

function _rotate(): void {
  if (!_basePath) return;
  try {
    _withLock(_basePath, () => {
      // Re-read inside lock to get freshest state
      const entries = _readEntriesFromDisk(_basePath!);
      if (entries.length <= MAX_ENTRIES) return;
      const trimmed = entries.slice(entries.length - MAX_ENTRIES);
      const lines = trimmed.map((e) => JSON.stringify(e));
      _atomicWrite(_basePath!, lines.join("\n") + "\n");
      _lineCount = trimmed.length;
    });
  } catch {
    // Non-fatal
  }
}

function _emitChange(): void {
  for (const listener of _changeListeners) {
    try {
      listener();
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Atomic file rewrite via temp-file + rename. Prevents partial reads
 * by other processes (web API subprocess, parallel workers).
 * Must be called inside _withLock for cross-process safety.
 */
function _atomicWrite(basePath: string, content: string): void {
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, FILENAME);
  const tmp = target + ".tmp." + process.pid;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, target);
}

/**
 * Acquire an exclusive lockfile for rewrite operations.
 * Uses O_CREAT|O_EXCL for atomic creation — if the file exists, another
 * process holds the lock. Clears stale locks, then proceeds anyway
 * (best-effort) to avoid blocking the UI.
 */
function _withLock<T>(basePath: string, fn: () => T): T {
  const lockPath = join(basePath, ".gsd", LOCKFILE);
  let fd: number | null = null;

  try {
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    fd = openSync(lockPath, "wx");
  } catch (err: any) {
    if (err?.code === "EEXIST") {
      // Check if lock is stale (older than 5s)
      try {
        const stat = readFileSync(lockPath, "utf-8");
        const lockTime = parseInt(stat, 10);
        if (Date.now() - lockTime > 5000) {
          try { unlinkSync(lockPath); } catch { /* race ok */ }
          try { fd = openSync(lockPath, "wx"); } catch { /* race ok */ }
        }
      } catch { /* proceed without lock */ }
    }
    // Any lock acquisition error leaves fd null; proceed without lock.
  }

  // Best-effort: mutation runs regardless of lock status (idempotent overwrites).
  // createdLock gates cleanup only — never skip fn() on lock failure.
  const createdLock = fd !== null;
  try {
    if (createdLock && fd !== null) {
      // Write our PID timestamp into the lock for stale detection
      writeFileSync(lockPath, String(Date.now()), "utf-8");
      closeSync(fd);
    }
    return fn();
  } finally {
    // Only delete the lock if we created it — never remove another process's lock
    if (createdLock) {
      try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ }
    }
  }
}
