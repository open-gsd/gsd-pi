// gsd-pi — ID-based path resolution for GSD project files and directories
/**
 * GSD Paths — ID-based path resolution
 *
 * Directories use bare IDs: M001/, S01/, etc.
 * Files use ID-SUFFIX: M001-ROADMAP.md, S01-PLAN.md, T01-PLAN.md
 *
 * Resolvers still handle legacy descriptor-suffixed names
 * (e.g. M001-FLIGHT-SIMULATOR/, T03-INSTALL-PACKAGES-PLAN.md)
 * via prefix matching, so existing projects work without migration.
 */

import { readdirSync, existsSync, realpathSync, statSync, Dirent } from "node:fs";
import { join, dirname, normalize, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { nativeScanGsdTree, type GsdTreeEntry } from "./native-parser-bridge.js";
import { DIR_CACHE_MAX } from "./constants.js";
import { gsdHome } from "./gsd-home.js";
import { findWorktreeSegment, isGsdWorktreePath, resolveExternalStateProjectGsdFromWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";
import {
  LAYOUT_SEGMENTS,
  milestoneIdToPhaseNum,
  milestoneIdUniqueSuffix,
  slicePlanFileName,
  slicePlanSegment,
  canonicalPhaseDirName,
} from "./layout-policy.js";

export { canonicalPhaseDirName };

// ─── Directory Listing Cache ──────────────────────────────────────────────────

const dirEntryCache = new Map<string, Dirent[]>();
const dirListCache = new Map<string, string[]>();

// ─── Native Tree Cache ────────────────────────────────────────────────────────
// When the native module is available, scan the entire .gsd/ tree in one call
// and serve directory listings from memory instead of individual readdirSync calls.

let nativeTreeCache: Map<string, GsdTreeEntry[]> | null = null;
let nativeTreeBase: string | null = null;

function getNativeTree(gsdDir: string): Map<string, GsdTreeEntry[]> | null {
  if (nativeTreeCache && nativeTreeBase === gsdDir) return nativeTreeCache;

  const entries = nativeScanGsdTree(gsdDir);
  if (!entries) return null;

  // Build a map of parent directory -> entries
  const tree = new Map<string, GsdTreeEntry[]>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const parentKey = parentPath || '.';
    if (!tree.has(parentKey)) tree.set(parentKey, []);
    tree.get(parentKey)!.push(entry);
  }

  nativeTreeCache = tree;
  nativeTreeBase = gsdDir;
  return tree;
}

/**
 * Convert a native tree lookup into a relative key for the tree map.
 * Returns the relative path from the gsdDir, or null if the path isn't under gsdDir.
 */
function nativeTreeKey(dirPath: string, gsdDir: string): string | null {
  if (!dirPath.startsWith(gsdDir)) return null;
  const rel = dirPath.slice(gsdDir.length).replace(/^\//, '');
  return rel || '.';
}

function cachedReaddirWithTypes(dirPath: string): Dirent[] {
  const cached = dirEntryCache.get(dirPath);
  if (cached) return cached;

  // Try native tree cache for paths under .gsd/
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        // Synthesize Dirent-like objects from native tree entries
        const dirents = treeEntries.map(e => {
          const d = Object.create(Dirent.prototype) as Dirent;
          Object.assign(d, {
            name: e.name,
            parentPath: dirPath,
            path: dirPath,
          });
          // Override the type check methods
          const isDir = e.isDir;
          d.isDirectory = () => isDir;
          d.isFile = () => !isDir;
          d.isSymbolicLink = () => false;
          d.isBlockDevice = () => false;
          d.isCharacterDevice = () => false;
          d.isFIFO = () => false;
          d.isSocket = () => false;
          return d;
        });
        if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
        dirEntryCache.set(dirPath, dirents);
        return dirents;
      }
    }
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
  dirEntryCache.set(dirPath, entries);
  return entries;
}

function cachedReaddir(dirPath: string): string[] {
  const cached = dirListCache.get(dirPath);
  if (cached) return cached;

  // Try native tree cache for paths under .gsd/
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        const names = treeEntries.map(e => e.name);
        if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
        dirListCache.set(dirPath, names);
        return names;
      }
    }
  }

  const entries = readdirSync(dirPath);
  if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
  dirListCache.set(dirPath, entries);
  return entries;
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Clear the volatile directory listing caches.
 * Call after milestone transitions, file creation in planning directories,
 * or at the start/end of a dispatch cycle.
 *
 * NOTE: This does NOT clear gsdRootCache. The project root is stable for
 * the lifetime of a process; clearing it on every agent turn-end caused a
 * 250–2500 ms regression per session (git rev-parse + dir walk per turn).
 * Use _clearGsdRootCache() at session-reset boundaries (workspace switch,
 * process exit) when the project root may genuinely change.
 */
export function clearPathCache(): void {
  dirEntryCache.clear();
  dirListCache.clear();
  nativeTreeCache = null;
  nativeTreeBase = null;
}

// ─── Name Builders ─────────────────────────────────────────────────────────

/** Directories owned by the GSD framework — metadata, never project source. */
export const FRAMEWORK_METADATA_DIRS: readonly string[] = [".gsd", ".planning", ".audits"];

/**
 * Every artifact suffix used with the name builders below — the single source
 * for the `<ID>-<SUFFIX>.md` naming vocabulary. Extend this list when a new
 * artifact type is introduced; consumers (md-importer walking, pre-execution
 * artifact detection) pick it up from here.
 */
export const PLANNING_ARTIFACT_SUFFIXES: readonly string[] = [
  "CONTEXT",
  "CONTEXT-DRAFT",
  "ROADMAP",
  "PLAN",
  "REPLAN",
  "SUMMARY",
  "RESEARCH",
  "UI-SPEC",
  "VALIDATION",
  "ASSESSMENT",
  "UAT",
  "DISCUSSION",
  "EVAL-REVIEW",
  "PARKED",
  "VERIFICATION-FAILED",
  "CONTINUE",
];

/** Matches a bare planning-artifact file name, e.g. "M001-CONTEXT.md", "S01-PLAN.md". */
export const PLANNING_ARTIFACT_NAME_RE = new RegExp(
  `^[MST]\\d+-(${PLANNING_ARTIFACT_SUFFIXES.join("|")})\\.md$`,
  "i",
);

/**
 * Build a milestone-level file name.
 * ("M001", "CONTEXT") → "M001-CONTEXT.md"
 */
export function buildMilestoneFileName(milestoneId: string, suffix: string): string {
  // Flat-phase: phase-level files are NN-SUFFIX.md (e.g. "01-CONTEXT.md")
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  return `${String(phaseNum).padStart(2, "0")}-${suffix}.md`;
}

/**
 * Build a slice-level file name.
 * ("S01", "PLAN") → "S01-PLAN.md"
 */
export function buildSliceFileName(sliceId: string, suffix: string): string {
  // Flat-phase: plan files need both phase and plan numbers (NN-MM-SUFFIX.md),
  // but this helper only has the sliceId. Callers needing the full name should
  // use slicePlanFileName() from layout-policy. This returns MM-SUFFIX.md for
  // any incremental callers that haven't migrated yet.
  return `${slicePlanSegment(sliceId)}-${suffix}.md`;
}

/**
 * Build a task file name.
 * ("T03", "PLAN") → "T03-PLAN.md"
 * ("T03", "SUMMARY") → "T03-SUMMARY.md"
 */
export function buildTaskFileName(taskId: string, suffix: string): string {
  // Flat-phase: tasks are checkboxes inside plan files, not separate files.
  // This helper is deprecated but kept for backward-compat callers.
  return `${taskId}-${suffix}.md`;
}

/**
 * Build a flat-phase task artifact file name.
 * ("S06", "T03", "SUMMARY") → "S06-T03-SUMMARY.md"
 */
export function buildFlatTaskFileName(sliceId: string, taskId: string, suffix: string): string {
  const redundantPrefix = `${sliceId}-`;
  const bareTaskId = taskId.toUpperCase().startsWith(redundantPrefix.toUpperCase())
    ? taskId.slice(redundantPrefix.length)
    : taskId;
  return `${sliceId}-${bareTaskId}-${suffix}.md`;
}

/**
 * Extract the task ID from a task artifact filename.
 * Supports flat-phase S##-T##-SUFFIX.md plus legacy T##-SUFFIX.md and
 * T##-DESCRIPTOR-SUFFIX.md names.
 */
export function taskIdFromTaskFileName(fileName: string, suffix: string): string | null {
  const flat = new RegExp(`^S\\d+-(T\\d+)-${suffix}\\.md$`, "i").exec(fileName);
  if (flat?.[1]) return flat[1].toUpperCase();
  const legacy = new RegExp(`^(T\\d+)(?:-.*)?-${suffix}\\.md$`, "i").exec(fileName);
  return legacy?.[1]?.toUpperCase() ?? null;
}

// ─── Resolvers ─────────────────────────────────────────────────────────────

/**
 * Find a directory entry by ID prefix within a parent directory.
 * Exact match first (M001), then prefix match (M001-SOMETHING) for
 * backward compatibility with legacy descriptor directories.
 * Returns the full directory name or null.
 */
export function resolveDir(parentDir: string, idPrefix: string): string | null {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = cachedReaddirWithTypes(parentDir);
    // Exact match first (current convention: bare ID)
    const exact = entries.find(e => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    const idLower = idPrefix.toLowerCase();
    const exactCaseInsensitive = entries.find(
      e => e.isDirectory() && e.name.toLowerCase() === idLower
    );
    if (exactCaseInsensitive) return exactCaseInsensitive.name;
    // Prefix match for legacy descriptor dirs: M001-SOMETHING
    const prefixed = entries.find(
      e => e.isDirectory() && e.name.toLowerCase().startsWith(idLower + "-")
    );
    return prefixed ? prefixed.name : null;
  } catch {
    return null;
  }
}

/**
 * Find a file by ID prefix and suffix within a directory.
 * Checks in order:
 *   1. Direct: ID-SUFFIX.md (e.g. M001-ROADMAP.md, T03-PLAN.md)
 *   2. Legacy descriptor: ID-DESCRIPTOR-SUFFIX.md (e.g. T03-INSTALL-PACKAGES-PLAN.md)
 *   3. Legacy bare: suffix.md (e.g. roadmap.md)
 */
export function resolveFile(dir: string, idPrefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const target = `${idPrefix}-${suffix}.md`.toUpperCase();
  try {
    const entries = cachedReaddirWithTypes(dir).filter(e => e.isFile()).map(e => e.name);
    // Direct match: ID-SUFFIX.md
    const direct = entries.find(e => e.toUpperCase() === target);
    if (direct) return direct;
    // Legacy pattern match: ID-DESCRIPTOR-SUFFIX.md
    const pattern = new RegExp(
      `^${idPrefix}-.*-${suffix}\\.md$`, "i"
    );
    const match = entries.find(e => pattern.test(e));
    if (match) return match;
    // Legacy fallback: suffix.md
    const legacy = entries.find(e => e.toLowerCase() === `${suffix.toLowerCase()}.md`);
    if (legacy) return legacy;
    return null;
  } catch {
    return null;
  }
}

/**
 * Find all task files matching a pattern in a tasks directory or flat phase dir.
 * Returns sorted file names matching S##-T##-SUFFIX.md, T##-SUFFIX.md,
 * or legacy T##-*-SUFFIX.md.
 */
export function resolveTaskFiles(tasksDir: string, suffix: string): string[] {
  if (!existsSync(tasksDir)) return [];
  try {
    return cachedReaddirWithTypes(tasksDir)
      .filter(e => e.isFile())
      .map(e => e.name)
      .filter(f => taskIdFromTaskFileName(f, suffix) !== null)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find all task JSON files matching a pattern in a tasks directory.
 * Returns sorted file names matching T##-SUFFIX.json or legacy T##-*-SUFFIX.json
 */
export function resolveTaskJsonFiles(tasksDir: string, suffix: string): string[] {
  if (!existsSync(tasksDir)) return [];
  try {
    const currentPattern = new RegExp(`^T\\d+-${suffix}\\.json$`, "i");
    const legacyPattern = new RegExp(`^T\\d+-.*-${suffix}\\.json$`, "i");
    return cachedReaddir(tasksDir)
      .filter(f => currentPattern.test(f) || legacyPattern.test(f))
      .sort();
  } catch {
    return [];
  }
}

// ─── Full Path Builders ────────────────────────────────────────────────────

export const GSD_ROOT_FILES = {
  PROJECT: "PROJECT.md",
  DECISIONS: "DECISIONS.md",
  QUEUE: "QUEUE.md",
  STATE: "STATE.md",
  REQUIREMENTS: "REQUIREMENTS.md",
  OVERRIDES: "OVERRIDES.md",
  KNOWLEDGE: "KNOWLEDGE.md",
  CODEBASE: "CODEBASE.md",
} as const;

export type GSDRootFileKey = keyof typeof GSD_ROOT_FILES;

const LEGACY_GSD_ROOT_FILES: Record<GSDRootFileKey, string> = {
  PROJECT: "project.md",
  DECISIONS: "decisions.md",
  QUEUE: "queue.md",
  STATE: "state.md",
  REQUIREMENTS: "requirements.md",
  OVERRIDES: "overrides.md",
  KNOWLEDGE: "knowledge.md",
  CODEBASE: "codebase.md",
};

// ─── GSD Root Discovery ───────────────────────────────────────────────────────

// Process-lifetime cache for gsdRoot() results.
// Keys are realpath-normalized (via normCacheKey) so /foo and /foo/ share the
// same entry and so do case-variant paths on case-insensitive volumes. This
// normalization is the safety net that prevents cache poisoning from the
// ~/.gsd walk-up bug (fixed in c46cf4786 + b35e070eb), making it safe to
// hold this cache for the entire process lifetime.
// Use _clearGsdRootCache() only at session-reset boundaries (workspace switch,
// process exit) — NOT inside clearPathCache(), which runs on every agent turn.
const gsdRootCache = new Map<string, string>();

export interface GsdPathContract {
  /** Canonical repo/project root where authoritative state lives. */
  projectRoot: string;
  /** Current execution root, which may be an auto-worktree. */
  workRoot: string;
  /** Canonical authoritative .gsd directory. */
  projectGsd: string;
  /** Legacy worktree-local .gsd projection directory, when applicable. */
  worktreeGsd: string | null;
  /** Canonical authoritative SQLite DB path. */
  projectDb: string;
  /** True when workRoot is inside a GSD worktree layout. */
  isWorktree: boolean;
}

export function resolveGsdPathContract(
  workRoot: string,
  originalProjectRoot?: string | null,
): GsdPathContract {
  const resolvedWorkRoot = resolve(workRoot || process.cwd());
  const isWorktree = isGsdWorktreePath(resolvedWorkRoot);
  if (isWorktree && !originalProjectRoot?.trim()) {
    const rawProjectGsd = resolveExternalStateProjectGsdFromWorktreePath(resolvedWorkRoot);
    if (rawProjectGsd) {
      // Canonicalize the `.gsd` root so the DB path matches what every other
      // accessor (gsdRoot/gsdProjectionRoot) returns — otherwise an unresolved
      // symlink (e.g. `/mnt/c/.../.gsd` → native ext4 on WSL) selects the wrong
      // journal mode and yields a fragile, move-prone handle. See issue #1239.
      const projectGsd = normalizeRealPath(rawProjectGsd);
      return {
        projectRoot: dirname(dirname(projectGsd)),
        workRoot: resolvedWorkRoot,
        projectGsd,
        worktreeGsd: normalizeRealPath(join(resolvedWorkRoot, ".gsd")),
        projectDb: join(projectGsd, "gsd.db"),
        isWorktree,
      };
    }
  }
  const projectRoot = resolve(resolveWorktreeProjectRoot(resolvedWorkRoot, originalProjectRoot));
  const projectGsd = normalizeRealPath(join(projectRoot, ".gsd"));
  const worktreeGsd = isWorktree ? normalizeRealPath(join(resolvedWorkRoot, ".gsd")) : null;

  return {
    projectRoot,
    workRoot: resolvedWorkRoot,
    projectGsd,
    worktreeGsd,
    projectDb: join(projectGsd, "gsd.db"),
    isWorktree,
  };
}

export function gsdProjectionRoot(basePath: string): string {
  const contract = resolveGsdPathContract(basePath);
  return normalizeRealPath(contract.worktreeGsd ?? contract.projectGsd);
}

/**
 * Invalidate the gsdRoot cache.
 * Use ONLY at session-reset boundaries: workspace switch, process exit, or
 * any context where the project root itself may genuinely change.
 * Do NOT call this on every agent turn — use clearPathCache() for volatile
 * directory listing invalidation instead.
 */
export function _clearGsdRootCache(): void {
  gsdRootCache.clear();
}

/**
 * Resolve a path to its canonical real path using the native resolver.
 * On macOS case-insensitive (HFS+/APFS) volumes, realpathSync.native normalizes
 * case — ensuring that /foo/Bar and /foo/bar resolve to the same string.
 * Falls back to resolve(p) for non-existent paths.
 *
 * Use this helper everywhere a path is used as an identity/cache key so that
 * all callers agree on the canonical form.
 */
export function normalizeRealPath(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/** Normalize a path for use as a gsdRootCache key (realpath + trailing-slash strip). */
function normCacheKey(p: string): string {
  const r = normalizeRealPath(p);
  const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Resolve the `.gsd` directory for a given project base path.
 *
 * Probe order:
 *   1. basePath/.gsd         — fast path (common case)
 *   2. git rev-parse root    — handles cwd-is-a-subdirectory
 *   3. Walk up from basePath — handles moved .gsd in an ancestor (bounded by git root)
 *   4. basePath/.gsd         — creation fallback (init scenario)
 *
 * Result is cached per normalized basePath for the process lifetime.
 * Keys are realpath-normalized so /foo and /foo/ share the same cache entry.
 */
export function gsdRoot(basePath: string): string {
  const cacheKey = normCacheKey(basePath);
  const cached = gsdRootCache.get(cacheKey);
  if (cached) return cached;

  // Canonicalize result via realpath before asserting and caching so that
  // callers always receive a canonical path regardless of whether probeGsdRoot
  // returned a path through a symlink. Without this, the cached value can
  // diverge from other realpath-normalized paths (e.g. workspace.identityKey).
  const result = normalizeRealPath(probeGsdRoot(basePath));

  // Defense-in-depth: if basePath resolves to the user's home directory and
  // the result equals gsdHome(), refuse — project-scoped writes must never
  // land in the global ~/.gsd. Paths under ~/.gsd/projects/<hash>/ are still
  // valid (their basePath does not equal homedir).
  assertNotGlobalGsdHome(basePath, result);

  gsdRootCache.set(cacheKey, result);
  return result;
}

function assertNotGlobalGsdHome(basePath: string, result: string): void {
  const norm = (p: string): string => {
    let r: string;
    try { r = realpathSync.native(p); } catch { r = p; }
    const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  let baseNorm: string;
  let homeNorm: string;
  let resultNorm: string;
  let gsdHomeNorm: string;
  try {
    baseNorm = norm(basePath);
    homeNorm = norm(homedir());
    resultNorm = norm(result);
    gsdHomeNorm = norm(gsdHome());
  } catch {
    return;
  }
  if (baseNorm === homeNorm && resultNorm === gsdHomeNorm) {
    throw new Error(
      `Refusing to use ${result} as a project .gsd directory — that is the global GSD home. ` +
      `Run GSD from inside a project directory.`,
    );
  }
}

/**
 * Detect if a path is inside a .gsd/worktrees/<name>/ structure.
 *
 * GSD auto-worktrees live at <project>/.gsd/worktrees/<milestoneId>/.
 * When gsdRoot() is called with such a path, we must NOT walk up to the
 * project root's .gsd — each worktree manages its own .gsd state (#2594).
 *
 * Layout matching is owned by worktree-root's findWorktreeSegment; this
 * only adds the requirement that a non-empty worktree name follows the
 * marker (the worktrees container dir itself is not a worktree).
 */
function isInsideGsdWorktree(p: string): boolean {
  const normalized = p.replaceAll("\\", "/");
  const segment = findWorktreeSegment(normalized);
  if (!segment) return false;
  const name = normalized.slice(segment.afterWorktrees).split("/")[0];
  return name.length > 0;
}

/** Prefix used by executeMigrationWrite temp dirs (`mkdtempSync(join(targetRoot, prefix))`). */
export const MIGRATION_STAGING_DIR_PREFIX = ".gsd-migrate-stage-";

/**
 * Detect a path inside a `.gsd-migrate-stage-*` temp dir.
 *
 * Staging lives under the target repo, so the git-root probe would otherwise
 * resolve to the live repo `.gsd` and write staged projection there (#1866).
 */
function isInsideMigrationStaging(p: string): boolean {
  return p.replaceAll("\\", "/").split("/").some((seg) => seg.startsWith(MIGRATION_STAGING_DIR_PREFIX));
}

function probeGsdRoot(rawBasePath: string): string {
  const contract = resolveGsdPathContract(rawBasePath);
  if (contract.isWorktree) return contract.projectGsd;

  // 1. Fast path — check the input path directly
  const local = join(rawBasePath, ".gsd");
  if (existsSync(local)) return local;

  // 1b. Worktree guard (#2594) — if basePath is inside a .gsd/worktrees/<name>/
  //     structure, return the worktree-local .gsd path immediately. Without this,
  //     the git-root probe (step 2) or walk-up (step 3) escapes to the project
  //     root's .gsd, causing ensurePreconditions() and deriveState() to read/write
  //     state in the wrong location.
  if (isInsideGsdWorktree(rawBasePath)) return local;

  // 1c. Migration staging (#1866) — temp dirs live inside the target repo, so
  //     git-root / walk-up would return the live `.gsd`. Keep staging local.
  if (isInsideMigrationStaging(rawBasePath)) return local;

  // Resolve symlinks so path comparisons work correctly across platforms
  // (e.g. macOS /var → /private/var). Use rawBasePath as fallback if not resolvable.
  let basePath: string;
  try { basePath = realpathSync.native(rawBasePath); } catch { basePath = rawBasePath; }

  // Also check the resolved path for the worktree pattern (macOS /tmp → /private/tmp)
  if (basePath !== rawBasePath && isInsideGsdWorktree(basePath)) return local;
  if (basePath !== rawBasePath && isInsideMigrationStaging(basePath)) return local;

  // 2. Git root anchor — used as both probe target and walk-up boundary
  //    Only walk if we're inside a git project — prevents escaping into
  //    unrelated filesystem territory when running outside any repo.
  let gitRoot: string | null = null;
  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8",
    });
    if (out.status === 0) {
      const r = out.stdout.trim();
      if (r) gitRoot = normalize(r);
    }
  } catch { /* git not available */ }

  // Compute gsdHome once for the skip-check used in steps 2 and 3.
  const normPath = (p: string): string => {
    let r: string;
    try { r = realpathSync.native(p); } catch { r = p; }
    const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  let gsdHomeNorm: string;
  try { gsdHomeNorm = normPath(gsdHome()); } catch { gsdHomeNorm = ""; }

  if (gitRoot) {
    const candidate = join(gitRoot, ".gsd");
    // Skip if the candidate resolves to the global GSD home — a subdir basePath
    // must not be anchored to ~/.gsd just because $HOME is a git repo.
    if (existsSync(candidate) && normPath(candidate) !== gsdHomeNorm) return candidate;
  }

  // 3. Walk up from basePath to the git root (only if we are in a subdirectory)
  if (gitRoot && basePath !== gitRoot) {
    let cur = dirname(basePath);
    while (cur !== basePath) {
      const candidate = join(cur, ".gsd");
      if (existsSync(candidate) && normPath(candidate) !== gsdHomeNorm) return candidate;
      if (cur === gitRoot) break;
      basePath = cur;
      cur = dirname(cur);
    }
  }

  // 4. Fallback for init/creation
  return local;
}
function legacyMilestonesHasSubdirs(basePath: string): boolean {
  const legacy = join(gsdProjectionRoot(basePath), "milestones");
  if (!existsSync(legacy)) return false;
  try {
    return readdirSync(legacy).some(e => statSync(join(legacy, e)).isDirectory() && dirIsContentBearingLegacyMilestone(join(legacy, e)));
  } catch {
    return false;
  }
}

/**
 * A `milestones/<MID>/` directory is only a real legacy layout entry if it
 * contains content files (CONTEXT/ROADMAP/SUMMARY/…). git-service.ts creates
 * `milestones/<MID>/` to store the integration-branch metadata
 * (`<MID>-META.json`) even in flat-phase projects, so a directory holding only
 * `*-META.json` must NOT count as legacy — otherwise layout detection flips to
 * legacy and artifact verification resolves to the wrong path
 * (`milestones/<MID>/<MID>-CONTEXT.md` instead of `phases/NN-slug/NN-CONTEXT.md`),
 * trapping the unit in a finalize-retry loop (#852 follow-up).
 *
 * See the matching TODO in markdown-renderer.ts detectStaleRenders, which
 * disabled stale-render detection for the same reason.
 */
const LEGACY_MILESTONE_RUNTIME_DIRS = new Set(["anchors"]);

export function dirIsContentBearingLegacyMilestone(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    // 1. Any non-META regular file → real legacy content.
    if (entries.some(e => e.isFile() && !e.name.endsWith("-META.json"))) return true;
    // 2. A non-empty non-runtime subdirectory → real legacy content (e.g. slices/ with slice dirs).
    //    An *empty* subdir is treated as scaffolding (e.g. git-service.ts may create
    //    an empty slices/ alongside the integration META file) and must NOT flip the
    //    layout — that is the Bugbot finding this guard addresses.
    return entries.some(e => {
      if (!e.isDirectory()) return false;
      if (LEGACY_MILESTONE_RUNTIME_DIRS.has(e.name)) return false;
      try { return readdirSync(join(dir, e.name)).length > 0; } catch { return false; }
    });
  } catch {
    return false;
  }
}

/**
 * Returns true iff the directory exists, is non-empty, and ALL entries are
 * `*-META.json` files (git-service integration-branch metadata pollution in a
 * flat-phase project). Used by resolveProjectMilestonePath to skip dirs that
 * only hold metadata — not as a layout-detection guard.
 *
 * Deliberately distinct from dirIsContentBearingLegacyMilestone: an EMPTY dir
 * (new milestone, no content written yet) returns false here because it is not
 * META-only — it is a valid placeholder that a writer may target.
 */
export function dirIsMetaOnlyLegacyMilestone(dir: string): boolean {
  try {
    const entries = readdirSync(dir);
    if (entries.length === 0) return false; // empty = not META-only
    return entries.every(name => name.endsWith("-META.json"));
  } catch {
    return false;
  }
}

export function isLegacyMilestonesLayout(basePath: string): boolean {
  return legacyMilestonesHasSubdirs(basePath);
}

export function milestonesDir(basePath: string): string {
  // Layout-aware: return milestones/ when it has legacy content, otherwise phases/.
  const root = gsdProjectionRoot(basePath);
  if (legacyMilestonesHasSubdirs(basePath)) {
    return join(root, "milestones");
  }
  return join(root, LAYOUT_SEGMENTS.level1);
}

/**
 * Legacy milestones directory (pre-flat-phase). Used as a fallback for
 * projects that haven't been migrated yet. The migration (flat-phase-migration.ts)
 * moves content from here to phases/ on startup.
 */
export function legacyMilestonesDir(basePath: string): string {
  return join(gsdProjectionRoot(basePath), "milestones");
}

/**
 * Resolve a phase directory by milestone id using the flat-phase layout.
 * Scans phases/ for a dir whose zero-padded number prefix matches the milestone.
 * Returns the full path or null if not found.
 */
function pickPreferredPhaseDir(phasesDir: string, matches: string[]): string {
  if (matches.length === 1) return matches[0]!;
  let best = matches[0]!;
  let bestMtime = -1;
  for (const name of matches) {
    try {
      const mtime = statSync(join(phasesDir, name)).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = name;
      }
    } catch {
      // unreadable — keep prior best
    }
  }
  return best;
}

function slugLooksLikeTeamSuffixProjection(slugPart: string): boolean {
  return /^[a-z0-9]{6}(-|$)/.test(slugPart);
}

export function phaseDirMatchesMilestoneId(
  dirName: string,
  milestoneId: string,
  phaseNum: number,
  allowTeamSuffixSlugs = false,
): boolean {
  const numMatch = dirName.match(/^(\d+)-(.*)$/);
  if (!numMatch || parseInt(numMatch[1]!, 10) !== phaseNum) return false;
  const slugPart = numMatch[2]!;
  const suffix = milestoneIdUniqueSuffix(milestoneId);
  if (suffix) {
    return slugPart === suffix || slugPart.startsWith(`${suffix}-`);
  }
  if (slugLooksLikeTeamSuffixProjection(slugPart) && !allowTeamSuffixSlugs) return false;
  return true;
}

function resolvePhaseDir(basePath: string, milestoneId: string): string | null {
  // Try flat-phase layout first: phases/NN-slug/ (always scan phases/, even when
  // legacy milestones/ coexists during partial migration).
  const phasesDir = join(gsdProjectionRoot(basePath), LAYOUT_SEGMENTS.level1);
  if (existsSync(phasesDir)) {
    const phaseNum = milestoneIdToPhaseNum(milestoneId);
    const canonical = canonicalPhaseDirName(milestoneId);
    if (existsSync(join(phasesDir, canonical))) {
      return join(phasesDir, canonical);
    }
    const matches: string[] = [];
    try {
      for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (phaseDirMatchesMilestoneId(entry.name, milestoneId, phaseNum)) {
          matches.push(entry.name);
        }
      }
      // Bare milestone ids may only have a suffixed team-mode projection on disk.
      if (matches.length === 0 && !milestoneIdUniqueSuffix(milestoneId)) {
        for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (phaseDirMatchesMilestoneId(entry.name, milestoneId, phaseNum, true)) {
            matches.push(entry.name);
          }
        }
      }
    } catch {
      // unreadable — fall through
    }
    if (matches.length > 0) {
      const preferred = matches.includes(canonical)
        ? canonical
        : pickPreferredPhaseDir(phasesDir, matches);
      return join(phasesDir, preferred);
    }
  }
  // Legacy fallback: milestones/M001/ (pre-flat-phase layout). Only consider a
  // milestone dir legacy if it actually carries content — git-service.ts creates
  // milestones/<MID>/ for integration-branch metadata even in flat-phase
  // projects, so a metadata-only dir must not flip the layout (#852 follow-up).
  const legacyDir = legacyMilestonesDir(basePath);
  if (existsSync(legacyDir)) {
    const candidate = resolveDir(legacyDir, milestoneId);
    if (candidate && dirIsContentBearingLegacyMilestone(join(legacyDir, candidate))) {
      return join(legacyDir, candidate);
    }
  }
  return null;
}

export function resolveRuntimeFile(basePath: string): string {
  return join(gsdRoot(basePath), "RUNTIME.md");
}

export function resolveGsdRootFile(basePath: string, key: GSDRootFileKey): string {
  const root = gsdRoot(basePath);
  const canonical = join(root, GSD_ROOT_FILES[key]);
  if (existsSync(canonical)) return canonical;
  const legacy = join(root, LEGACY_GSD_ROOT_FILES[key]);
  if (existsSync(legacy)) return legacy;
  return canonical;
}

export function relGsdRootFile(key: GSDRootFileKey): string {
  return `.gsd/${GSD_ROOT_FILES[key]}`;
}

/**
 * Resolve the full path to a milestone directory.
 * Returns null if the milestone doesn't exist.
 */
export function resolveMilestonePath(basePath: string, milestoneId: string): string | null {
  // Flat-phase: scan phases/ for NN-slug dir matching the milestone number.
  const phaseDir = resolvePhaseDir(basePath, milestoneId);
  if (phaseDir) return phaseDir;
  // Legacy fallback: try old milestones/ dir (pre-flat-phase layout). Same
  // content-bearing guard as resolvePhaseDir — a metadata-only milestones/<MID>/
  // (created by git-service.ts for the integration branch) must not be treated
  // as a real legacy milestone dir (#852 follow-up).
  const oldMilestonesDir = join(gsdProjectionRoot(basePath), "milestones");
  if (existsSync(oldMilestonesDir)) {
    const legacyDir = resolveDir(oldMilestonesDir, milestoneId);
    if (legacyDir && dirIsContentBearingLegacyMilestone(join(oldMilestonesDir, legacyDir))) {
      return join(oldMilestonesDir, legacyDir);
    }
  }
  return null;
}

/**
 * Returns true iff a milestone directory physically exists on disk, regardless
 * of whether it is content-bearing.
 *
 * Distinct from resolveMilestonePath, which intentionally returns null for a
 * legacy `milestones/<MID>/` directory that holds only scaffolding (e.g. an
 * empty `slices/` created by discuss/queue flows before any CONTEXT/ROADMAP is
 * written). That content-bearing gate is right for artifact resolution but
 * wrong as a "directory is missing from disk" proxy: the workflow prompts
 * create the milestone directory early, so a queued milestone in normal
 * in-flight planning would otherwise look like an orphan. Use this to decide
 * whether a milestone directory is truly absent (no directory at all) vs merely
 * empty. See doctor-runtime-checks.ts orphan_milestone_db (#1524).
 */
export function milestoneDirExists(basePath: string, milestoneId: string): boolean {
  // Flat-phase dirs (and content-bearing legacy dirs) resolve directly.
  if (resolveMilestonePath(basePath, milestoneId)) return true;
  // Legacy layout: a scaffold-only milestones/<MID>/ directory exists on disk
  // but is not content-bearing, so resolveMilestonePath returns null. Treat the
  // bare directory as present.
  const oldMilestonesDir = join(gsdProjectionRoot(basePath), "milestones");
  if (existsSync(oldMilestonesDir) && resolveDir(oldMilestonesDir, milestoneId)) {
    return true;
  }
  return false;
}

/**
 * Resolve the full path to a milestone file (e.g. ROADMAP, CONTEXT, RESEARCH).
 */
export function resolveMilestoneFile(
  basePath: string, milestoneId: string, suffix: string
): string | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  // Flat-phase: phase-level files are NN-SUFFIX.md (e.g. 01-CONTEXT.md)
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const prefix = `${String(phaseNum).padStart(2, "0")}`;
  const flatName = `${prefix}-${suffix}.md`;
  const flatPath = join(mDir, flatName);
  if (isExistingFile(flatPath)) return flatPath;
  // Legacy fallback: M001-SUFFIX.md
  const file = resolveFile(mDir, milestoneId, suffix);
  return file ? join(mDir, file) : null;
}

/**
 * Resolve the full path to a slice directory within a milestone.
 */
export function resolveSlicePath(
  basePath: string, milestoneId: string, sliceId: string
): string | null {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  // Legacy: slice files live under slices/SID/ when that subdir exists.
  const slicesDir = join(mDir, "slices");
  const dir = resolveDir(slicesDir, sliceId);
  if (dir) return join(slicesDir, dir);
  // Flat-phase: plans are files inside the phase dir, not subdirs.
  return mDir;
}

/**
 * Resolve the full path to a slice file (e.g. PLAN, RESEARCH, CONTEXT, SUMMARY).
 */
export function resolveSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string
): string | null {
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  if (!phaseDir) return null;
  // Flat-phase: plan files are NN-MM-SUFFIX.md inside the phase dir.
  // The segment comes from the canonical layout mapping, never from digits
  // guessed out of a non-canonical slice id (#1975): R01 must not resolve
  // to S01's 01-01-* files.
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const planSegment = slicePlanSegment(sliceId);
  const flatName = slicePlanFileName(phaseNum, sliceId, suffix);
  const flatPath = join(phaseDir, flatName);
  if (isExistingFile(flatPath)) return flatPath;
  // Also check plan-number-only format MM-SUFFIX.md (written by buildSliceFileName)
  const planOnlyName = `${planSegment}-${suffix}.md`;
  const planOnlyPath = join(phaseDir, planOnlyName);
  if (isExistingFile(planOnlyPath)) return planOnlyPath;
  // Try prefix match for the phase+plan number (handles suffix variations)
  const planPrefix = `${String(phaseNum).padStart(2, "0")}-${planSegment}-`;
  try {
    for (const entry of readdirSync(phaseDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(planPrefix) && entry.name.endsWith(`-${suffix}.md`)) {
        return join(phaseDir, entry.name);
      }
    }
  } catch {
    // unreadable
  }
  // Legacy fallback: try old slices/SID/ dir structure
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (sDir && sDir !== phaseDir) {
    const file = resolveFile(sDir, sliceId, suffix);
    if (file) return join(sDir, file);
  }
  return null;
}

/**
 * Resolve the tasks directory within a slice.
 */
export function resolveTasksDir(
  basePath: string, milestoneId: string, sliceId: string
): string | null {
  // Flat-phase: no tasks/ subdir. Tasks live as checkboxes inside plan files.
  // Legacy fallback for old layouts:
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  const tDir = join(sDir, "tasks");
  return existsSync(tDir) ? tDir : null;
}

/**
 * Resolve a specific task file.
 */
export function resolveTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string
): string | null {
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  if (!phaseDir) return null;

  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = phaseDir.startsWith(legacyBase + "/") || phaseDir.startsWith(legacyBase + "\\");

  if (suffix !== "PLAN" && !isLegacy) {
    const flatPath = join(phaseDir, buildFlatTaskFileName(sliceId, taskId, suffix));
    if (isExistingFile(flatPath)) return flatPath;
    const legacyFlatPath = join(phaseDir, buildTaskFileName(taskId, suffix));
    return isExistingFile(legacyFlatPath) ? legacyFlatPath : null;
  }

  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (tDir) {
    const file = resolveFile(tDir, taskId, suffix);
    if (file) return join(tDir, file);
  }

  return null;
}

// ─── Relative Path Builders (for prompts — .gsd/milestones/...) ────────────

/**
 * Build relative .gsd/ path to a milestone directory.
 * Uses the actual directory name on disk if it exists, otherwise the canonical
 * flat-phase dir name the renderer will create (NN-slug).
 *
 * Pass `title` when the milestone title is available so the fallback slug
 * matches what the renderer will create.  Without a title the phase number is
 * used as a placeholder (no DB import is allowed here — db/engine uses
 * import.meta.url which breaks the Next.js SSR build path).
 */
export function relMilestonePath(basePath: string, milestoneId: string, title?: string): string {
  // resolvePhaseDir handles both flat-phase (phases/NN-*) and legacy (milestones/M001).
  const phaseDir = resolvePhaseDir(basePath, milestoneId);
  if (phaseDir) {
    const name = phaseDir.split(/[/\\]/).pop()!;
    // Use the correct segment based on which layout the resolved dir lives under.
    const legacyBase = legacyMilestonesDir(basePath);
    if (phaseDir.startsWith(legacyBase + "/") || phaseDir.startsWith(legacyBase + "\\")) {
      return `.gsd/milestones/${name}`;
    }
    return `.gsd/${LAYOUT_SEGMENTS.level1}/${name}`;
  }
  // No dir on disk yet — derive canonical flat-phase name.
  // If the caller provides the milestone title, the slug will match what the
  // renderer creates (e.g. "01-foundation").  Without a title, falls back to
  // the milestone ID as the slug placeholder (e.g. "01-m001").
  return `.gsd/${LAYOUT_SEGMENTS.level1}/${canonicalPhaseDirName(milestoneId, title)}`;
}

/**
 * Build the canonical absolute write target for a milestone file.
 * Existing compatibility filenames are intentionally ignored; readers that need
 * to preserve an existing file should call resolveMilestoneFile first.
 */
export function targetMilestoneFile(
  basePath: string, milestoneId: string, suffix: string, title?: string
): string {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = mDir
    ? mDir.startsWith(legacyBase + "/") || mDir.startsWith(legacyBase + "\\")
    : isLegacyMilestonesLayout(basePath);
  const dir = mDir ?? join(
    isLegacy ? legacyBase : milestonesDir(basePath),
    isLegacy ? milestoneId : canonicalPhaseDirName(milestoneId, title),
  );
  const fileName = isLegacy
    ? `${milestoneId}-${suffix}.md`
    : `${String(milestoneIdToPhaseNum(milestoneId)).padStart(2, "0")}-${suffix}.md`;
  return join(dir, fileName);
}

/**
 * Build relative .gsd/ path to a milestone file.
 * Preserves an existing compatibility filename when present; otherwise falls
 * back to the canonical write target.
 */
export function relMilestoneFile(
  basePath: string, milestoneId: string, suffix: string, title?: string
): string {
  const rel = relative(
    gsdProjectionRoot(basePath),
    resolveMilestoneFile(basePath, milestoneId, suffix) ?? targetMilestoneFile(basePath, milestoneId, suffix, title),
  ).replace(/\\/g, "/");
  return `.gsd/${rel}`;
}

/**
 * Build relative .gsd/ path to a slice directory.
 * Layout-aware: legacy projects include a slices/S01/ subdir;
 * flat-phase projects use the phase dir directly.
 *
 * @param milestoneTitle - Optional milestone title passed through to
 *   relMilestonePath so the flat-phase fallback dir name uses the human-readable
 *   slug ("05-milestone-five") rather than the bare ID slug ("05-m005").
 *   Only consulted when no phase directory exists on disk yet.
 */
export function relSlicePath(
  basePath: string, milestoneId: string, sliceId: string, milestoneTitle?: string
): string {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (mDir) {
    const legacyBase = legacyMilestonesDir(basePath);
    if (mDir.startsWith(legacyBase + "/") || mDir.startsWith(legacyBase + "\\")) {
      // Legacy: slices live under milestones/M001/slices/S01/
      const mRel = relMilestonePath(basePath, milestoneId);
      const slicesDir = join(mDir, "slices");
      const dir = resolveDir(slicesDir, sliceId);
      return `${mRel}/slices/${dir ?? sliceId}`;
    }
  }
  // Flat-phase: plans are files inside the phase dir, no slices/ subdir.
  return relMilestonePath(basePath, milestoneId, milestoneTitle);
}

/**
 * Build the canonical absolute write target for a slice file.
 * Existing compatibility filenames are intentionally ignored; readers that need
 * to preserve an existing file should call resolveSliceFile first.
 */
export function targetSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string, milestoneTitle?: string
): string {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = mDir
    ? mDir.startsWith(legacyBase + "/") || mDir.startsWith(legacyBase + "\\")
    : isLegacyMilestonesLayout(basePath);
  const milestoneDir = mDir
    ?? dirname(targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestoneTitle));
  const slicesDir = join(milestoneDir, "slices");
  const dir = isLegacy
    ? join(slicesDir, resolveDir(slicesDir, sliceId) ?? sliceId)
    : milestoneDir;
  const fileName = isLegacy
    ? `${sliceId}-${suffix}.md`
    : slicePlanFileName(milestoneIdToPhaseNum(milestoneId), sliceId, suffix);
  return join(dir, fileName);
}

/**
 * Build the canonical absolute write target for a task file.
 * Readers that need legacy flat-phase fallback should call resolveTaskFile.
 */
export function targetTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string, milestoneTitle?: string
): string {
  if (suffix === "PLAN") {
    return targetSliceFile(basePath, milestoneId, sliceId, "PLAN", milestoneTitle);
  }

  const mDir = resolveMilestonePath(basePath, milestoneId);
  const legacyBase = legacyMilestonesDir(basePath);
  const isLegacy = mDir
    ? mDir.startsWith(legacyBase + "/") || mDir.startsWith(legacyBase + "\\")
    : isLegacyMilestonesLayout(basePath);
  const milestoneDir = mDir
    ?? dirname(targetMilestoneFile(basePath, milestoneId, "ROADMAP", milestoneTitle));

  if (isLegacy) {
    const slicesDir = join(milestoneDir, "slices");
    const sliceDir = join(slicesDir, resolveDir(slicesDir, sliceId) ?? sliceId);
    return join(sliceDir, "tasks", buildTaskFileName(taskId, suffix));
  }

  return join(milestoneDir, buildFlatTaskFileName(sliceId, taskId, suffix));
}

/**
 * Build relative .gsd/ path to a slice file.
 * Preserves an existing compatibility filename when present; otherwise falls
 * back to the canonical write target.
 */
export function relSliceFile(
  basePath: string, milestoneId: string, sliceId: string, suffix: string, milestoneTitle?: string
): string {
  const rel = relative(
    gsdProjectionRoot(basePath),
    resolveSliceFile(basePath, milestoneId, sliceId, suffix)
      ?? targetSliceFile(basePath, milestoneId, sliceId, suffix, milestoneTitle),
  ).replace(/\\/g, "/");
  return `.gsd/${rel}`;
}

/**
 * Build relative .gsd/ path to a task file.
 *
 * Legacy layout:  slices/SID/tasks/TID-SUFFIX.md (inside a slices/ subdir)
 * Flat-phase:     PLAN → slice plan path (tasks as checkboxes); other suffixes
 *                 (e.g. SUMMARY) → phase dir / TID-SUFFIX.md
 */
export function relTaskFile(
  basePath: string, milestoneId: string, sliceId: string,
  taskId: string, suffix: string, milestoneTitle?: string
): string {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  // Legacy: slice path is a slices/SID/ subdir inside the milestone dir
  if (sDir && phaseDir && sDir !== phaseDir) {
    const relS = relSlicePath(basePath, milestoneId, sliceId);
    return `${relS}/tasks/${taskId}-${suffix}.md`;
  }
  // Flat-phase: task plans are checkboxes inside the slice plan file
  if (suffix === "PLAN") {
    return relSliceFile(basePath, milestoneId, sliceId, "PLAN");
  }
  const relS = relSlicePath(basePath, milestoneId, sliceId, milestoneTitle);
  return `${relS}/${buildFlatTaskFileName(sliceId, taskId, suffix)}`;
}
