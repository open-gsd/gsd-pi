import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gsdHome } from "./gsd-home.js";

export interface WorktreeSegment {
  gsdIdx: number;
  afterWorktrees: number;
}

export function normalizeWorktreePathForCompare(path: string): string {
  let normalized: string;
  try {
    normalized = realpathSync(path);
  } catch {
    normalized = resolve(path);
  }
  const slashed = normalized.replaceAll("\\", "/");
  const trimmed = slashed.replace(/\/+$/, "");
  return process.platform === "win32" ? (trimmed || "/").toLowerCase() : (trimmed || "/");
}

/**
 * Find the GSD worktree segment in the canonical layout (.gsd-worktrees/),
 * the legacy direct layout (.gsd/worktrees/), and the symlink-resolved
 * external-state layout used by ~/.gsd/projects/<hash>.
 */
export function findWorktreeSegment(normalizedPath: string): WorktreeSegment | null {
  const canonicalMarker = "/.gsd-worktrees/";
  const canonicalIdx = normalizedPath.indexOf(canonicalMarker);
  if (canonicalIdx !== -1) {
    return { gsdIdx: canonicalIdx, afterWorktrees: canonicalIdx + canonicalMarker.length };
  }

  const directMarker = "/.gsd/worktrees/";
  const directIdx = normalizedPath.indexOf(directMarker);
  if (directIdx !== -1) {
    return { gsdIdx: directIdx, afterWorktrees: directIdx + directMarker.length };
  }

  const externalRe = /\/\.gsd\/projects\/[^/]+\/worktrees\//;
  const externalMatch = normalizedPath.match(externalRe);
  if (externalMatch && externalMatch.index !== undefined) {
    return {
      gsdIdx: externalMatch.index,
      afterWorktrees: externalMatch.index + externalMatch[0].length,
    };
  }

  const projectsRoot = join(process.env.GSD_STATE_DIR || gsdHome(), "projects")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const marker = `${projectsRoot}/`;
  if (normalizedPath.startsWith(marker)) {
    const rel = normalizedPath.slice(marker.length);
    const worktreesIdx = rel.indexOf("/worktrees/");
    if (worktreesIdx > 0) {
      const gsdIdx = marker.length + worktreesIdx;
      return {
        gsdIdx,
        afterWorktrees: gsdIdx + "/worktrees/".length,
      };
    }
  }

  return null;
}

export function isGsdWorktreePath(path: string): boolean {
  return findWorktreeSegment(path.replaceAll("\\", "/")) !== null;
}

/**
 * Project-root prefix of a GSD worktree path, or null when the path is not
 * inside a recognized worktree layout. Pure string split — no env handling,
 * HOME guard, or filesystem fallbacks (resolveWorktreeProjectRoot adds
 * those). Separator normalization is 1:1 on characters, so the prefix is
 * sliced from the ORIGINAL string and keeps its separators.
 */
export function projectRootFromWorktreePath(path: string): string | null {
  const segment = findWorktreeSegment(path.replaceAll("\\", "/"));
  return segment ? path.slice(0, segment.gsdIdx) : null;
}

/**
 * When a milestone worktree lives under the external-state layout
 * (`<gsdHome>/projects/<hash>/worktrees/<MID>/`, or the `GSD_STATE_DIR`
 * equivalent), return the parent project's authoritative external `.gsd`
 * directory. Returns null for direct layout worktrees
 * (`<repo>/.gsd/worktrees/<MID>/`).
 */
export function resolveExternalStateProjectGsdFromWorktreePath(projectPath: string): string | null {
  const normalized = resolve(projectPath).replaceAll("\\", "/");

  // Canonical/direct layouts — parent state is resolved via repoIdentity(git root).
  if (normalized.includes("/.gsd-worktrees/")) return null;
  if (normalized.includes("/.gsd/worktrees/") && !normalized.includes("/.gsd/projects/")) {
    return null;
  }

  const externalDotGsd = /[/\\]\.gsd[/\\]projects[/\\][^/\\]+[/\\]worktrees(?:[/\\]|$)/.exec(normalized);
  if (externalDotGsd && externalDotGsd.index !== undefined) {
    const worktreesIdx = externalDotGsd[0].search(/[/\\]worktrees(?:[/\\]|$)/);
    return resolve(normalized.slice(0, externalDotGsd.index + worktreesIdx));
  }

  const projectsRoot = join(process.env.GSD_STATE_DIR || gsdHome(), "projects").replaceAll("\\", "/").replace(/\/+$/, "");
  const marker = `${projectsRoot}/`;
  if (normalized.startsWith(marker)) {
    const rel = normalized.slice(marker.length);
    const slash = rel.indexOf("/");
    if (slash === -1) return null;
    const hash = rel.slice(0, slash);
    const rest = rel.slice(slash + 1);
    if (rest.startsWith("worktrees/") || rest === "worktrees") {
      return resolve(projectsRoot, hash);
    }
  }

  return null;
}

/**
 * Identity hash for an external-state project directory (`basename` of the
 * `~/.gsd/projects/<hash>` path). Returns null when the path is not in that
 * layout.
 */
export function resolveExternalStateProjectIdentityFromWorktreePath(projectPath: string): string | null {
  const projectGsd = resolveExternalStateProjectGsdFromWorktreePath(projectPath);
  return projectGsd ? basename(projectGsd) : null;
}

/**
 * Resolve the canonical project root for worktree operations.
 *
 * `originalBasePath` wins when available because session state already knows the
 * root. `GSD_PROJECT_ROOT` is the next strongest signal for worker processes.
 * Otherwise, derive the root from direct `.gsd/worktrees` paths, or recover it
 * from the worktree `.git` file for symlink-resolved ~/.gsd/project paths.
 */
export function resolveWorktreeProjectRoot(
  basePath: string,
  originalBasePath?: string | null,
): string {
  const explicitOriginal = originalBasePath?.trim();
  if (explicitOriginal) return resolveProjectRootFromPath(explicitOriginal);

  const envProjectRoot = process.env.GSD_PROJECT_ROOT?.trim();
  if (envProjectRoot && isGsdWorktreePath(basePath)) {
    return resolveProjectRootFromPath(envProjectRoot);
  }

  return resolveProjectRootFromPath(basePath || envProjectRoot || process.cwd());
}

export function resolveWorktreeOwningProjectRoot(basePath: string): string {
  return resolveProjectRootFromPath(basePath);
}

function resolveProjectRootFromPath(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segment = findWorktreeSegment(normalizedPath);
  if (!segment) {
    return resolveNearestBootstrappedGsdRoot(path) ?? resolveGitWorkingTreeRoot(path) ?? path;
  }

  // Slice at the first `.gsd` boundary, but never past the worktree segment:
  // in the canonical layout (`<root>/.gsd-worktrees/<MID>/.gsd/...`) the first
  // `/.gsd/` occurrence is the worktree-local projection dir, not the project
  // root's state dir.
  const sepChar = path.includes("\\") ? "\\" : "/";
  const gsdMarker = `${sepChar}.gsd${sepChar}`;
  const markerIdx = path.indexOf(gsdMarker);
  const sliceIdx = markerIdx !== -1 ? Math.min(markerIdx, segment.gsdIdx) : segment.gsdIdx;
  const candidate = path.slice(0, sliceIdx);

  const gsdHomeNorm = normalizeWorktreePathForCompare(gsdHome());
  const candidateGsdPath = normalizeWorktreePathForCompare(join(candidate, ".gsd"));

  if (candidateGsdPath === gsdHomeNorm || candidateGsdPath.startsWith(`${gsdHomeNorm}/`)) {
    const realRoot = resolveProjectRootFromGitFile(path);
    return realRoot ?? path;
  }

  return candidate;
}

function resolveNearestBootstrappedGsdRoot(path: string): string | null {
  try {
    let dir = existsSync(path) && !statSync(path).isDirectory()
      ? resolve(path, "..")
      : path;
    const externalStateParent = normalizeWorktreePathForCompare(resolve(gsdHome(), ".."));

    for (let i = 0; i < 30; i++) {
      if (normalizeWorktreePathForCompare(dir) === externalStateParent) return null;
      if (hasGsdBootstrapArtifacts(join(dir, ".gsd"))) return dir;

      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) return null;

      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Non-fatal: callers fall back to git root resolution.
  }
  return null;
}

function hasGsdBootstrapArtifacts(gsdPath: string): boolean {
  return existsSync(gsdPath) &&
    (existsSync(join(gsdPath, "PREFERENCES.md")) ||
      existsSync(join(gsdPath, "preferences.md")) ||
      existsSync(join(gsdPath, "milestones")));
}

function resolveGitWorkingTreeRoot(path: string): string | null {
  try {
    let dir = existsSync(path) && !statSync(path).isDirectory()
      ? resolve(path, "..")
      : path;
    const externalStateParent = normalizeWorktreePathForCompare(resolve(gsdHome(), ".."));

    for (let i = 0; i < 30; i++) {
      if (normalizeWorktreePathForCompare(dir) === externalStateParent) return null;
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) return dir;

      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Non-fatal: callers either keep the original path or fail closed.
  }
  return null;
}

function resolveProjectRootFromGitFile(worktreePath: string): string | null {
  try {
    let dir = worktreePath;
    for (let i = 0; i < 30; i++) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const content = readFileSync(gitPath, "utf8").trim();
        if (content.startsWith("gitdir: ")) {
          const gitDir = resolve(dir, content.slice(8));
          const dotGitDir = resolve(gitDir, "..", "..");
          if (dotGitDir.endsWith(".git") || dotGitDir.endsWith(".git/") || dotGitDir.endsWith(".git\\")) {
            return resolve(dotGitDir, "..");
          }

          const commonDirPath = join(gitDir, "commondir");
          if (existsSync(commonDirPath)) {
            const commonDir = readFileSync(commonDirPath, "utf8").trim();
            const resolvedCommonDir = resolve(gitDir, commonDir);
            return resolve(resolvedCommonDir, "..");
          }
        }
        break;
      }

      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Non-fatal: callers either keep the original path or fail closed.
  }
  return null;
}
