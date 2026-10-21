// GSD worktree session state
import { findWorktreeSegment, projectRootFromWorktreePath } from "./worktree-root.js";

let originalCwd: string | null = null;

export function getWorktreeOriginalCwd(): string | null {
  return originalCwd;
}

export function setWorktreeOriginalCwd(cwd: string): void {
  originalCwd = cwd;
}

export function clearWorktreeOriginalCwd(): void {
  originalCwd = null;
}

export function ensureWorktreeOriginalCwdFromPath(cwd: string = process.cwd()): string | null {
  if (originalCwd) return originalCwd;
  const root = projectRootFromWorktreePath(cwd);
  if (root) originalCwd = root;
  return originalCwd;
}

export function getActiveWorktreeName(basePath: string = process.cwd()): string | null {
  if (!originalCwd) return null;
  const normalizedCwd = basePath.replaceAll("\\", "/");
  const normalizedOriginal = originalCwd.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  const segment = findWorktreeSegment(normalizedCwd);
  if (!segment) return null;
  // Only treat the cwd as an active worktree of OUR project root.
  if (normalizedCwd.slice(0, segment.gsdIdx) !== normalizedOriginal) return null;
  const name = normalizedCwd.slice(segment.afterWorktrees).split("/")[0];
  return name || null;
}
