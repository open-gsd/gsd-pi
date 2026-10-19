// Project/App: gsd-pi
// File Purpose: Test-only fixture that creates a legacy worktree-local gsd.db copy.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { snapshotDatabaseFile } from "../../db/engine.ts";

/** Copy a project gsd.db to a worktree path. Returns false when the source is missing. */
export function copyWorktreeDb(srcDbPath: string, destDbPath: string): boolean {
  if (!existsSync(srcDbPath)) return false;
  mkdirSync(dirname(destDbPath), { recursive: true });
  snapshotDatabaseFile(srcDbPath, destDbPath);
  return true;
}
