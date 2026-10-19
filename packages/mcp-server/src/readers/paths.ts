// GSD MCP Server — .gsd/ directory resolution

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
//
// Read-only MCP tools (gsd_progress, gsd_roadmap, gsd_doctor, …) hammer the
// filesystem on every call: gsd_roadmap alone resolves milestone directories
// 5–6× per milestone, and resolveGsdRoot can spawn `git rev-parse` for
// non-direct .gsd/ layouts. Without caching, an MCP host pipelining several
// tool calls blocks the event loop on dozens of redundant readdir/stat
// syscalls per request.
//
// Two layers:
//   * resolveGsdRoot — short TTL (the result depends on a possibly-expensive
//     git subprocess; projectDir is stable for the life of an MCP session).
//   * readdir-backed lookups — keyed on the directory's mtime, so any add/
//     remove/rename invalidates the cache automatically.

const GSD_ROOT_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 256;
const gsdRootCache = new Map<string, { value: string; expiresAt: number }>();

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function cachedGsdRoot(projectDir: string): string | null {
  const hit = gsdRootCache.get(projectDir);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    gsdRootCache.delete(projectDir);
    return null;
  }
  setBoundedCache(gsdRootCache, projectDir, hit);
  return hit.value;
}

function rememberGsdRoot(projectDir: string, value: string): void {
  setBoundedCache(gsdRootCache, projectDir, { value, expiresAt: Date.now() + GSD_ROOT_TTL_MS });
}

interface MtimeEntry<V> { mtimeMs: number; value: V }

/**
 * Read-through cache keyed on a directory path's mtime. Returns the cached
 * value if the directory's mtime is unchanged since the last write; otherwise
 * runs `compute` and stores the new result. Misses on read errors (ENOENT,
 * EACCES) are cached via `compute`'s own return value, but the cache entry
 * is dropped if the directory disappears later.
 */
function readWithMtimeCache<V>(
  cache: Map<string, MtimeEntry<V>>,
  cacheKey: string,
  dir: string,
  compute: () => V,
  cloneForStore: (value: V) => V = (value) => value,
  cloneForReturn: (value: V) => V = (value) => value,
): V {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    cache.delete(cacheKey);
    return compute();
  }
  const hit = cache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) {
    setBoundedCache(cache, cacheKey, hit);
    return cloneForReturn(hit.value);
  }
  const value = cloneForStore(compute());
  setBoundedCache(cache, cacheKey, { mtimeMs, value });
  return cloneForReturn(value);
}

const milestoneIdsCache = new Map<string, MtimeEntry<string[]>>();
const phaseIdsCache = new Map<string, MtimeEntry<string[]>>();
const milestoneDirCache = new Map<string, MtimeEntry<string | null>>();
const sliceIdsCache = new Map<string, MtimeEntry<string[]>>();
const sliceDirCache = new Map<string, MtimeEntry<string | null>>();
const taskFilesCache = new Map<string, MtimeEntry<Array<{ id: string; hasPlan: boolean; hasSummary: boolean; done?: boolean }>>>();

function cloneStringArray(value: string[]): string[] {
  return Array.from(value);
}

function cloneTaskFiles(
  value: Array<{ id: string; hasPlan: boolean; hasSummary: boolean; done?: boolean }>,
): Array<{ id: string; hasPlan: boolean; hasSummary: boolean; done?: boolean }> {
  return value.map((task) => ({ ...task }));
}

/** @internal — exported for testing only */
export function _resetReaderCaches(): void {
  gsdRootCache.clear();
  milestoneIdsCache.clear();
  phaseIdsCache.clear();
  milestoneDirCache.clear();
  sliceIdsCache.clear();
  sliceDirCache.clear();
  taskFilesCache.clear();
}

/**
 * Resolve the .gsd/ root directory for a project.
 *
 * Probes in order:
 *   1. projectDir/.gsd (fast path)
 *   2. git repo root/.gsd
 *   3. Walk up from projectDir
 *   4. Fallback: projectDir/.gsd (even if missing — for init)
 */
export function resolveGsdRoot(projectDir: string): string {
  const resolved = resolve(projectDir);

  const cached = cachedGsdRoot(resolved);
  if (cached) return cached;

  // Fast path: .gsd/ in the given directory
  const direct = join(resolved, '.gsd');
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    rememberGsdRoot(resolved, direct);
    return direct;
  }

  // Try git repo root
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolved,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const gitGsd = join(gitRoot, '.gsd');
    if (existsSync(gitGsd) && statSync(gitGsd).isDirectory()) {
      rememberGsdRoot(resolved, gitGsd);
      return gitGsd;
    }
  } catch {
    // Not a git repo or git not available
  }

  // Walk up from projectDir
  let dir = resolved;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, '.gsd');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      rememberGsdRoot(resolved, candidate);
      return candidate;
    }
    dir = dirname(dir);
  }

  // Fallback — don't cache so that an init() call right after this is seen.
  return direct;
}

/** Resolve path to a .gsd/ root file (STATE.md, KNOWLEDGE.md, etc.) */
export function resolveRootFile(gsdRoot: string, name: string): string {
  return join(gsdRoot, name);
}

/** Resolve path to milestones directory */
export function milestonesDir(gsdRoot: string): string {
  return join(gsdRoot, 'milestones');
}

/**
 * Numeric phase for a milestone id ("M001" → 1, "M010" → 10). Mirrors the
 * extension's milestoneIdToPhaseNum (src/resources/extensions/gsd/layout-policy.ts)
 * so both tools read the same phases/NN-slug/ layout.
 */
function milestonePhaseNum(milestoneId: string): number | null {
  const m = milestoneId.match(/^M0*(\d+)/i);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * Find all milestone directory IDs (M001, M002, etc.).
 * Scans both layouts the product writes:
 *   * legacy milestones/ — bare (M001/) and descriptor (M001-FLIGHT-SIM/) dirs
 *   * flat-phase phases/ — NN-slug dirs ("01-foundation" → "M001")
 */
export function findMilestoneIds(gsdRoot: string): string[] {
  const ids = new Set<string>();

  const dir = milestonesDir(gsdRoot);
  if (existsSync(dir)) {
    for (const id of readWithMtimeCache(milestoneIdsCache, dir, dir, () => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^(M\d+)/);
        if (match) found.push(match[1]);
      }
      return found;
    }, cloneStringArray, cloneStringArray)) {
      ids.add(id);
    }
  }

  const phasesDir = join(gsdRoot, 'phases');
  if (existsSync(phasesDir)) {
    for (const id of readWithMtimeCache(phaseIdsCache, phasesDir, phasesDir, () => {
      const entries = readdirSync(phasesDir, { withFileTypes: true });
      const found: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^(\d+)-/);
        if (match) found.push(`M${match[1]!.padStart(3, '0')}`);
      }
      return found;
    }, cloneStringArray, cloneStringArray)) {
      ids.add(id);
    }
  }

  return Array.from(ids).sort();
}

/**
 * Resolve the actual directory for a milestone ID across both layouts.
 * Flat-phase (phases/NN-slug/) wins over legacy (milestones/M001/), mirroring
 * the extension resolver's priority — a milestone present in both during a
 * partial migration resolves to its phases/ dir.
 */
export function resolveMilestoneDir(gsdRoot: string, milestoneId: string): string | null {
  const phaseNum = milestonePhaseNum(milestoneId);
  if (phaseNum !== null) {
    const phasesDir = join(gsdRoot, 'phases');
    if (existsSync(phasesDir)) {
      const flat = readWithMtimeCache(milestoneDirCache, `${phasesDir} ${milestoneId}`, phasesDir, () => {
        const entries = readdirSync(phasesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const m = entry.name.match(/^(\d+)-/);
          if (m && Number.parseInt(m[1]!, 10) === phaseNum) {
            return join(phasesDir, entry.name);
          }
        }
        return null;
      });
      if (flat) return flat;
    }
  }

  const dir = milestonesDir(gsdRoot);
  if (!existsSync(dir)) return null;

  return readWithMtimeCache(milestoneDirCache, `${dir} ${milestoneId}`, dir, () => {
    // Fast path: exact match
    const exact = join(dir, milestoneId);
    if (existsSync(exact) && statSync(exact).isDirectory()) return exact;

    // Prefix match
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(milestoneId)) {
        return join(dir, entry.name);
      }
    }

    return null;
  });
}

/**
 * Resolve a milestone-level file (M001-ROADMAP.md, 01-ROADMAP.md, etc.).
 * Handles both layouts' naming conventions.
 */
export function resolveMilestoneFile(gsdRoot: string, milestoneId: string, suffix: string): string | null {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return null;

  const dirName = basename(mDir);

  // Try: M001-ROADMAP.md, DIRNAME-ROADMAP.md, flat-phase 01-ROADMAP.md, ROADMAP.md
  const candidates = [
    join(mDir, `${milestoneId}-${suffix}.md`),
    join(mDir, `${dirName}-${suffix}.md`),
  ];
  const phaseNum = milestonePhaseNum(milestoneId);
  if (phaseNum !== null) {
    candidates.push(join(mDir, `${String(phaseNum).padStart(2, '0')}-${suffix}.md`));
  }
  candidates.push(join(mDir, `${suffix}.md`));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Slice segment inside flat-phase plan file names ("01" for S01, "R01" for a
 * remediation slice). Mirrors the extension's slicePlanSegment
 * (src/resources/extensions/gsd/layout-policy.ts) so both read the same files.
 */
function slicePlanSegment(sliceId: string): string {
  const m = sliceId.match(/^S0*(\d+)(?:-.*)?$/i);
  if (m) return String(Number.parseInt(m[1]!, 10)).padStart(2, '0');
  if (/^\d+$/.test(sliceId)) return String(Number.parseInt(sliceId, 10)).padStart(2, '0');
  return sliceId;
}

/** Inverse of slicePlanSegment: flat-phase file segment back to a slice id. */
function sliceSegmentToId(segment: string): string {
  return /^\d+$/.test(segment) ? `S${segment}` : canonicalSliceId(segment);
}

/**
 * Canonical slice id ("s1" → "S01", "S01-replan" → "S01-replan" is NOT
 * canonicalized beyond case). Mirrors the writer, which pads canonical
 * S-ids to two digits, so filename-derived ids from different sources
 * (plan segments vs artifact prefixes) reconcile to one slice.
 */
function canonicalSliceId(id: string): string {
  const m = id.match(/^S0*(\d+)$/i);
  return m ? `S${m[1]!.padStart(2, '0')}` : id.toUpperCase();
}

/** Find all slice IDs within a milestone (S01, S02, etc.) */
export function findSliceIds(gsdRoot: string, milestoneId: string): string[] {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return [];

  const slicesDir = join(mDir, 'slices');
  if (existsSync(slicesDir)) {
    return readWithMtimeCache(sliceIdsCache, slicesDir, slicesDir, () => {
      const entries = readdirSync(slicesDir, { withFileTypes: true });
      const ids: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^(S\d+)/);
        if (match) ids.push(match[1]);
      }
      return ids.sort();
    }, cloneStringArray, cloneStringArray);
  }

  // Flat-phase layout: slice plan/summary files (NN-MM-SUFFIX.md) and task
  // artifacts (SS-TNN-SUFFIX.md) sit directly under the milestone dir.
  return readWithMtimeCache(sliceIdsCache, `${slicesDir} flat`, mDir, () => {
    const ids = new Set<string>();
    for (const entry of readdirSync(mDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const plan = entry.name.match(/^\d+-(\d{2,}|[A-Z]\d*)-(?:PLAN|SUMMARY)\.md$/i);
      if (plan) {
        ids.add(sliceSegmentToId(plan[1]!));
        continue;
      }
      const task = entry.name.match(/^([A-Z]\d+)-T\d+-(?:PLAN|SUMMARY)\.md$/i);
      if (task) ids.add(canonicalSliceId(task[1]!));
    }
    return Array.from(ids).sort();
  }, cloneStringArray, cloneStringArray);
}

/** Resolve the actual directory for a slice */
export function resolveSliceDir(gsdRoot: string, milestoneId: string, sliceId: string): string | null {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return null;

  const slicesDir = join(mDir, 'slices');
  if (!existsSync(slicesDir)) return null;

  return readWithMtimeCache(sliceDirCache, `${slicesDir} ${sliceId}`, slicesDir, () => {
    const exact = join(slicesDir, sliceId);
    if (existsSync(exact) && statSync(exact).isDirectory()) return exact;

    const entries = readdirSync(slicesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(sliceId)) {
        return join(slicesDir, entry.name);
      }
    }
    return null;
  });
}

/** Resolve a slice-level file (S01-PLAN.md, etc.) */
export function resolveSliceFile(
  gsdRoot: string, milestoneId: string, sliceId: string, suffix: string,
): string | null {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return null;

  const slicesDir = join(mDir, 'slices');
  if (existsSync(slicesDir)) {
    const sDir = resolveSliceDir(gsdRoot, milestoneId, sliceId);
    if (!sDir) return null;

    const dirName = basename(sDir);
    const candidates = [
      join(sDir, `${sliceId}-${suffix}.md`),
      join(sDir, `${dirName}-${suffix}.md`),
      join(sDir, `${suffix}.md`),
    ];

    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  // Flat-phase layout: NN-MM-SUFFIX.md directly under the milestone dir
  // (mirrors the extension's slicePlanFileName).
  const phaseNum = milestonePhaseNum(milestoneId);
  if (phaseNum !== null) {
    const flat = join(mDir, `${String(phaseNum).padStart(2, '0')}-${slicePlanSegment(sliceId)}-${suffix}.md`);
    if (existsSync(flat)) return flat;
  }
  return null;
}

/** Find all task files in a slice's tasks/ directory */
export function findTaskFiles(
  gsdRoot: string, milestoneId: string, sliceId: string,
): Array<{ id: string; hasPlan: boolean; hasSummary: boolean; done?: boolean }> {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return [];

  const slicesDir = join(mDir, 'slices');
  if (existsSync(slicesDir)) {
    const sDir = resolveSliceDir(gsdRoot, milestoneId, sliceId);
    if (!sDir) return [];
    const tasksDir = join(sDir, 'tasks');
    if (!existsSync(tasksDir)) return [];

    return readWithMtimeCache(taskFilesCache, tasksDir, tasksDir, () => {
      const files = readdirSync(tasksDir);
      const taskMap = new Map<string, { hasPlan: boolean; hasSummary: boolean }>();

      for (const f of files) {
        const match = f.match(/^(T\d+).*-(PLAN|SUMMARY)\.md$/i);
        if (!match) continue;
        const [, id, type] = match;
        const existing = taskMap.get(id) ?? { hasPlan: false, hasSummary: false };
        if (type.toUpperCase() === 'PLAN') existing.hasPlan = true;
        if (type.toUpperCase() === 'SUMMARY') existing.hasSummary = true;
        taskMap.set(id, existing);
      }

      return Array.from(taskMap.entries())
        .map(([id, info]) => ({ id, ...info }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }, cloneTaskFiles, cloneTaskFiles);
  }

  // Flat-phase layout: task artifacts (SS-TNN-SUFFIX.md) sit directly under
  // the milestone dir, prefixed with the slice id. The slice's plan file is
  // the task state carrier (tasks are checkboxes inside it, not separate
  // files), so checkbox tasks are merged into the inventory — consumers
  // counting only artifact files would report pending tasks as absent and
  // half-done slices as done. `done` carries the checkbox state so
  // artifact-less completed tasks are not miscounted as pending.
  const sliceKey = canonicalSliceId(sliceId);
  let planKey = '';
  const phaseNum = milestonePhaseNum(milestoneId);
  const planPath = phaseNum !== null
    ? join(mDir, `${String(phaseNum).padStart(2, '0')}-${slicePlanSegment(sliceId)}-PLAN.md`)
    : null;
  if (planPath && existsSync(planPath)) {
    // Plan content edits do not touch the directory mtime — fold the plan
    // file's own mtime into the cache key so edits invalidate.
    try {
      planKey = ` plan:${statSync(planPath).mtimeMs}`;
    } catch {
      planKey = '';
    }
  }
  return readWithMtimeCache(taskFilesCache, `${mDir} ${sliceKey} flat${planKey}`, mDir, () => {
    const taskMap = new Map<string, { hasPlan: boolean; hasSummary: boolean; done?: boolean }>();

    for (const f of readdirSync(mDir)) {
      const match = f.match(/^(.+?)-(T\d+)-(PLAN|SUMMARY)\.md$/i);
      if (!match) continue;
      if (canonicalSliceId(match[1]!) !== sliceKey) continue;
      const id = match[2]!.toUpperCase();
      const type = match[3]!.toUpperCase();
      const existing = taskMap.get(id) ?? { hasPlan: false, hasSummary: false };
      if (type === 'PLAN') existing.hasPlan = true;
      if (type === 'SUMMARY') existing.hasSummary = true;
      taskMap.set(id, existing);
    }

    // Merge checkbox tasks from the slice's flat plan file (NN-MM-PLAN.md).
    // Renderer plans carry tasks in an authoritative <tasks> block — scope
    // the scan to it when present so task-shaped lines elsewhere in the
    // document cannot add phantom tasks or flip checked state. Legacy plans
    // have no block; scan the whole file for their checkbox lines.
    if (planPath && existsSync(planPath)) {
      const plan = readFileSync(planPath, 'utf-8');
      const block = plan.match(/<tasks>\s*\n([\s\S]*?)\n\s*<\/tasks>/);
      const scan = block ? block[1]! : plan;
      // Both task line shapes: renderer "- [x] **T01**: Title" and legacy
      // "- [x] **T01: Title**" — id and checked state are all that is needed.
      const taskRe = /^-\s+\[([ xX])\]\s+\*\*(T\d+)(?:\*\*|:)/gm;
      let match: RegExpExecArray | null;
      while ((match = taskRe.exec(scan)) !== null) {
        const id = match[2]!.toUpperCase();
        const existing = taskMap.get(id) ?? { hasPlan: false, hasSummary: false };
        existing.hasPlan = true;
        existing.done = match[1] !== ' ';
        taskMap.set(id, existing);
      }
    }

    return Array.from(taskMap.entries())
      .map(([id, info]) => ({ id, ...info }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, cloneTaskFiles, cloneTaskFiles);
}
