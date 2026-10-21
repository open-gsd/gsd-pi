// gsd-pi - /gsd migrate safety helpers.
// File Purpose: Path resolution, target guards, and backup support for v1 migration.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { readCrashLock, isLockProcessAlive } from "../crash-recovery.js";
import { closeWorkflowDatabase } from "../db-workspace.js";
import { readPausedSessionMetadata } from "../interrupted-session.js";
import { gsdRoot } from "../paths.js";
import { canonicalWorktreesDir } from "../worktree-placement.js";
import type { MigrationPreview } from "./writer.js";
import { acquireProjectionRootIdentityLock, type ProjectionRootIdentityLock } from "@gsd/native/file-identity";
import {
  assertMigrationProjectionRootIdentity,
  proveMigrationProjectionRoot,
  withMigrationProjectionRoot,
  type MigrationProjectionRootIdentity,
} from "./publication-store.js";

export interface MigrationPaths {
  sourcePath: string;
  targetRoot: string;
}

export interface MigrationBackup {
  hadExistingGsd: boolean;
  backupPath: string | null;
  targetGsdPath: string;
}

export class MigrationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationBlockedError";
  }
}

function expandHome(pathArg: string): string {
  if (pathArg === "~") return homedir();
  if (pathArg.startsWith("~/")) return join(homedir(), pathArg.slice(2));
  return pathArg;
}

export function resolveMigrationPaths(args: string, cwd: string = process.cwd()): MigrationPaths {
  const rawPath = expandHome(args.trim() || ".");
  const resolved = resolve(cwd, rawPath);

  if (basename(resolved) === ".planning") {
    return {
      sourcePath: resolved,
      targetRoot: dirname(resolved),
    };
  }

  return {
    sourcePath: join(resolved, ".planning"),
    targetRoot: resolved,
  };
}

function formatBackupTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function nextBackupPath(handle: ProjectionRootIdentityLock, targetRoot: string, now: Date): {
  absolutePath: string;
  logicalPath: string;
} {
  const baseName = `migrate-${formatBackupTimestamp(now)}`;
  let name = baseName;
  let suffix = 2;

  if (handle.pathExists(".gsd-backups") && handle.pathKind(".gsd-backups") !== "directory") {
    throw new Error("migration backup root is not an identity-stable directory");
  }
  while (handle.pathExists(`.gsd-backups/${name}`)) {
    name = `${baseName}-${suffix}`;
    suffix++;
  }

  return {
    absolutePath: join(targetRoot, ".gsd-backups", name),
    logicalPath: `.gsd-backups/${name}`,
  };
}

export function prepareMigrationTarget(
  targetRoot: string,
  now: Date = new Date(),
  expectedProjectionRoot?: MigrationProjectionRootIdentity,
): MigrationBackup {
  const projectionRoot = proveMigrationProjectionRoot(targetRoot);
  if (expectedProjectionRoot !== undefined) {
    assertMigrationProjectionRootIdentity({
      targetRoot,
      projectionRootIdentity: expectedProjectionRoot,
    });
  }
  const targetGsdPath = gsdRoot(targetRoot);
  if (!existsSync(targetGsdPath)) {
    return { hadExistingGsd: false, backupPath: null, targetGsdPath };
  }

  const targetHandle = acquireProjectionRootIdentityLock(
    projectionRoot.targetPath,
    projectionRoot.targetDevice,
    projectionRoot.targetInode,
  );
  let backupPath: string;
  try {
    const backup = nextBackupPath(targetHandle, projectionRoot.targetPath, now);
    backupPath = backup.absolutePath;
    targetHandle.createDirectory(backup.logicalPath);
    withMigrationProjectionRoot(targetRoot, projectionRoot, (_boundRoot, sourceHandle) => {
      const copyDirectory = (relativePath: string, destination: string): void => {
        for (const name of sourceHandle.listDirectory(relativePath)) {
          if (/^gsd\.db(?:$|-)/u.test(name)) continue;
          const source = relativePath.length === 0 ? name : `${relativePath}/${name}`;
          const target = `${destination}/${name}`;
          if (sourceHandle.pathKind(source) === "directory") copyDirectory(source, target);
          else targetHandle.writeFile(target, sourceHandle.readFile(source));
        }
      };
      copyDirectory("", backup.logicalPath);
    });
    targetHandle.syncRoot();
  } finally {
    targetHandle.close();
  }
  assertMigrationProjectionRootIdentity({
    targetRoot,
    projectionRootIdentity: projectionRoot,
  });

  return { hadExistingGsd: true, backupPath, targetGsdPath };
}

export function assertMigrationHasSlices(preview: MigrationPreview): void {
  if (preview.totalSlices > 0) return;
  throw new MigrationBlockedError(
    "Migration blocked - the legacy project would produce zero slices. Add a ROADMAP.md or phases/ content before migrating.",
  );
}

function hasWorktreeState(targetRoot: string): boolean {
  // Legacy container is probed via gsdRoot() (symlink-resolved) on purpose —
  // migration targets may have .gsd in the external-state layout.
  const containers = [
    canonicalWorktreesDir(targetRoot),
    join(gsdRoot(targetRoot), "worktrees"),
  ];
  for (const worktreesDir of containers) {
    if (!existsSync(worktreesDir)) continue;
    try {
      if (readdirSync(worktreesDir, { withFileTypes: true })
        .some((entry) => entry.isDirectory() || entry.isFile())) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export async function assertMigrationTargetAvailable(targetRoot: string): Promise<void> {
  const targetGsdPath = gsdRoot(targetRoot);
  if (!existsSync(targetGsdPath)) return;

  if (hasWorktreeState(targetRoot)) {
    throw new MigrationBlockedError(
      "Migration blocked - existing GSD worktree state is present. Resolve or clean worktrees before migrating.",
    );
  }

  const opened = await ensureDbOpen(targetRoot);
  if (!opened) return;

  try {
    const lock = readCrashLock(targetRoot);
    if (lock && lock.pid !== process.pid && isLockProcessAlive(lock)) {
      throw new MigrationBlockedError(
        `Migration blocked - auto-mode appears to be running for this project (PID ${lock.pid}). Stop it before migrating.`,
      );
    }

    const paused = readPausedSessionMetadata(targetRoot);
    if (paused) {
      throw new MigrationBlockedError(
        "Migration blocked - a paused auto-mode session exists for this project. Resume or stop it before migrating.",
      );
    }
  } finally {
    closeWorkflowDatabase();
  }
}
