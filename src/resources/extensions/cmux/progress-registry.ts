// Project/App: gsd-pi
// File Purpose: Workspace-scoped progress coordination for the cmux sidebar (issue #2926, ADR-051).
//
// cmux exposes exactly one workspace-scoped progress slot (`set-progress` /
// `clear-progress`, no key), unlike keyed statuses. GSD sessions sharing a
// workspace coordinate over a per-workspace registry directory in the OS temp
// directory — the cmux CLI and its default socket path already assume a single
// local machine. The registry holds ONE FILE PER SESSION
// (`<dir>/sessions/<key>.json` with `{ pid, progress, updatedAt }`), and each
// session only ever creates, updates, or removes its own file:
//
// - No read-modify-write on shared state exists, so concurrent mutations
//   cannot lose a member (a whole-file registry with atomic rename would
//   still lose the loser of a last-writer-wins race).
// - The shared slot is only ever written with the deterministic fold over the
//   live directory listing, so any session that refreshes the slot writes the
//   same value and concurrent refreshes converge. There is no owner to go
//   idle and freeze a stale bar.
// - Entries whose pid is no longer alive are removed on every listing — there
//   is deliberately no expiry timeout; a crashed session is detected by pid
//   death.
// - A session removing itself only deletes its own file, and only when the
//   recorded pid still matches, so a same-key replacement that registered in
//   the meantime is never removed.
//
// Full policy and residual risks: docs/dev/ADR-051.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CmuxStateInput } from "../shared/cmux-events.js";

/** Per-level progress a session reports (verbatim subset of CmuxStateInput). */
export type CmuxProgressLevels = NonNullable<CmuxStateInput["progress"]>;

export interface CmuxProgressMember {
  pid: number;
  progress: CmuxProgressLevels | null;
  /** Informational only — liveness is pid-based, there is no expiry timeout. */
  updatedAt: string;
}

/** Cross-session sums per level; a level is present when any member reported it. */
export interface CmuxProgressSums {
  milestones: { done: number; total: number };
  slices?: { done: number; total: number };
  tasks?: { done: number; total: number };
}

export type CmuxProgressEntries = Record<string, CmuxProgressMember>;

/** Registry directory for a workspace (`workspace:<n>` is sanitized). */
export function cmuxProgressRegistryDir(workspaceId: string | undefined, dir: string = tmpdir()): string {
  const sanitized = (workspaceId ?? "default").replace(/[^A-Za-z0-9._-]/g, "-");
  return join(dir, `gsd-cmux-progress-${sanitized}`);
}

function sessionsDir(registryDir: string): string {
  return join(registryDir, "sessions");
}

function entryPath(registryDir: string, sessionKey: string): string {
  // encodeURIComponent keeps the key filename-safe across platforms and is
  // injective (":" is escaped), so distinct session keys never collide.
  return join(sessionsDir(registryDir), `${encodeURIComponent(sessionKey)}.json`);
}

function ensureDirs(registryDir: string): void {
  if (!existsSync(sessionsDir(registryDir))) {
    mkdirSync(sessionsDir(registryDir), { recursive: true });
  }
}

/** pid-liveness probe: EPERM means the process exists under another user. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface CmuxProgressListing {
  live: CmuxProgressEntries;
  /**
   * Session keys whose entry was removed here because its pid is dead (or the
   * file was corrupt garbage). The caller can safely clear those sessions'
   * orphaned status rows: the pruned pid proves that identity is gone.
   */
  reapedKeys: string[];
}

/**
 * List the live member entries. Entries whose recorded pid is dead are
 * unlinked (idempotent, any member may do it) and reported as reaped; entries
 * that are corrupt or unreadable are treated as garbage, unlinked, and
 * reported too — their owner re-registers on its next sync.
 */
export function listLiveEntries(registryDir: string, alive: (pid: number) => boolean = isPidAlive): CmuxProgressListing {
  const live: CmuxProgressEntries = {};
  const reapedKeys: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir(registryDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return { live, reapedKeys };
  }
  for (const name of names) {
    const file = join(sessionsDir(registryDir), name);
    const key = decodeURIComponent(name.replace(/\.json$/, ""));
    try {
      const member = JSON.parse(readFileSync(file, "utf-8")) as CmuxProgressMember;
      if (!member || typeof member.pid !== "number" || !alive(member.pid)) {
        rmSync(file, { force: true });
        reapedKeys.push(key);
        continue;
      }
      live[key] = member;
    } catch {
      rmSync(file, { force: true });
      reapedKeys.push(key);
    }
  }
  return { live, reapedKeys };
}

/**
 * Create or update this session's own entry (temp file + rename, so a
 * concurrent listing never sees a torn file). Skips the write when the
 * recorded entry already matches.
 */
export function writeSessionEntry(registryDir: string, sessionKey: string, member: CmuxProgressMember): void {
  ensureDirs(registryDir);
  const file = entryPath(registryDir, sessionKey);
  try {
    const existing = JSON.parse(readFileSync(file, "utf-8")) as CmuxProgressMember;
    if (existing && existing.pid === member.pid && JSON.stringify(existing.progress) === JSON.stringify(member.progress)) {
      return;
    }
  } catch {
    // Missing or unreadable — (re)write below.
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(member)}\n`);
  renameSync(tmp, file);
}

/**
 * Remove this session's own entry, but only when the recorded pid is still
 * ours — a same-key replacement (new process, same surface id) that
 * registered in the meantime must survive our cleanup. Returns true when the
 * entry was removed.
 */
export function removeSessionEntry(registryDir: string, sessionKey: string, pid: number): boolean {
  const file = entryPath(registryDir, sessionKey);
  try {
    const existing = JSON.parse(readFileSync(file, "utf-8")) as CmuxProgressMember;
    if (!existing || existing.pid !== pid) return false;
  } catch {
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

/** True when the directory currently holds an entry for `sessionKey`. */
export function hasSessionEntry(registryDir: string, sessionKey: string): boolean {
  return existsSync(entryPath(registryDir, sessionKey));
}

/**
 * Deterministic aggregation over live members: each level is summed across
 * the members reporting that level (total > 0). The deepest-level preference
 * (tasks before slices before milestones) is applied downstream by
 * `buildCmuxProgress`, mirroring the single-session semantics exactly.
 * Returns null when no member reports progress.
 */
export function aggregateProgress(entries: CmuxProgressEntries): CmuxProgressSums | null {
  const milestones = { done: 0, total: 0 };
  const slices = { done: 0, total: 0 };
  const tasks = { done: 0, total: 0 };
  let reporting = 0;
  for (const member of Object.values(entries)) {
    const progress = member?.progress;
    if (!progress) continue;
    reporting += 1;
    if (progress.milestones && progress.milestones.total > 0) {
      milestones.done += progress.milestones.done;
      milestones.total += progress.milestones.total;
    }
    if (progress.slices && progress.slices.total > 0) {
      slices.done += progress.slices.done;
      slices.total += progress.slices.total;
    }
    if (progress.tasks && progress.tasks.total > 0) {
      tasks.done += progress.tasks.done;
      tasks.total += progress.tasks.total;
    }
  }
  if (reporting === 0) return null;
  return {
    milestones,
    ...(slices.total > 0 ? { slices } : {}),
    ...(tasks.total > 0 ? { tasks } : {}),
  };
}
