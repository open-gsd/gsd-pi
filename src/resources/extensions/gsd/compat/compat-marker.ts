// Project/App: gsd-pi
// File Purpose: gsd-core ↔ gsd-pi compatibility marker (`.gsd/.compat.json`).
//
// Records per-projection content hashes so the Projection Worker can distinguish
// gsd-pi's own writes from external edits whose exact bytes must be preserved.
// gsd-core is oblivious to this file and ignores it.

import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import { atomicWriteSync } from "../atomic-write.js";
import { computeProjectionSha } from "../projection-content-hash.js";
import { isSafeProjectionKey, isValidCompatMarker } from "./compat-marker-validation.js";
export { computeProjectionSha, normalizeForHash } from "../projection-content-hash.js";

/** Current marker schema version. Bump on breaking format changes + migrate. */
export const COMPAT_MARKER_SCHEMA = 2;

/**
 * Which `.planning/` layout a project uses. Captured on first read so the
 * round-trip writer recreates the same structure gsd-core wrote. Priority
 * matches migrate/transformer.ts transformToGSD.
 */
export type PlanningLayout = "flat-phases" | "multi-milestone" | "legacy-milestone-dir";

/**
 * `.planning/` projection tracking. `projections` are modeled files (roadmap,
 * plans, summaries, state) whose external bytes are preserved before a DB-backed
 * rebuild; `passthrough` are un-modeled docs (DISCUSSION-LOG, PATTERNS, REVIEWS,
 * codebase/) that get sha-refreshed only — content is never re-rendered.
 */
export interface PlanningMarker {
  active: boolean;
  layout: PlanningLayout | null;
  projections: Record<string, ProjectionEntry>;
  passthrough: Record<string, ProjectionEntry>;
}

/**
 * Per-file projection entry. `sha` is a normalized-content SHA-256; `entities`
 * is the list of DB entity ids (milestone/slice/task) that the file projects,
 * retained as typed scope evidence when an external edit is observed.
 */
export interface ProjectionEntry {
  sha: string;
  entities: string[];
}

export interface CompatMarker {
  schema: number;
  lastWriter: "gsd-pi";
  lastProjectedAt: string;
  projections: Record<string, ProjectionEntry>;
  /** Optional: `.planning/` layout tracking for gsd-core parity. */
  planning?: PlanningMarker;
  piVersion: string;
}

export interface ReadCompatMarkerOptions {
  /** Rewrite invalid-but-derivable marker keys back to safe root-relative keys. */
  healInvalidKeys?: boolean;
  /** Quarantine malformed/unsafe markers. Disable only for read-only previews. */
  quarantineInvalid?: boolean;
}

/** Marker returned when no marker exists yet (fresh project, first gsd-pi run). */
export const EMPTY_MARKER: CompatMarker = {
  schema: COMPAT_MARKER_SCHEMA,
  lastWriter: "gsd-pi",
  lastProjectedAt: "",
  projections: {},
  planning: { active: false, layout: null, projections: {}, passthrough: {} },
  piVersion: "",
};

export function compatMarkerPath(basePath: string): string {
  return join(basePath, ".gsd", ".compat.json");
}

/**
 * Normalize markdown content before hashing so cosmetic differences (trailing
 * whitespace, CRLF) don't produce false-positive drift. Conservative: only
 * transforms that are provably round-trippable through gsd-pi's projection.
 */
function normalizeRealPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function rootRelativeKey(rootPath: string, absPath: string): string | null {
  const root = normalizeRealPath(rootPath);
  const abs = normalizeRealPath(absPath);
  const rel = relative(root, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sepForRelative(rel)}`) || isAbsolute(rel)) {
    return null;
  }
  return rel.replace(/\\/g, "/");
}

function sepForRelative(rel: string): string {
  return rel.includes("\\") ? "\\" : "/";
}

export function deriveCompatProjectionKey(absPath: string, roots: readonly string[]): string {
  for (const root of roots) {
    const key = rootRelativeKey(root, absPath);
    if (key) return key;
  }
  const fallbackRoot = roots[roots.length - 1] ?? dirname(absPath);
  return relative(fallbackRoot, absPath).replace(/\\/g, "/");
}

/**
 * Read and validate the marker. A missing marker returns EMPTY_MARKER so future
 * projection writes can establish baselines. A malformed marker is quarantined
 * to `.compat.json.bad-<ts>` (never overwrite without backup) then returns
 * EMPTY_MARKER. A schema mismatch returns EMPTY_MARKER (forward compatibility:
 * refuse to act on a future format we don't understand).
 */
export function readCompatMarker(
  basePath: string,
  options: ReadCompatMarkerOptions = {},
): CompatMarker {
  const healInvalidKeys = options.healInvalidKeys ?? true;
  const quarantineInvalid = options.quarantineInvalid ?? true;
  const path = compatMarkerPath(basePath);
  if (!existsSync(path)) return emptyMarker();

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return emptyMarker();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (quarantineInvalid) quarantine(basePath, raw);
    return emptyMarker();
  }

  if (healInvalidKeys && healMarkerProjectionKeys(basePath, parsed) && isValidCompatMarker(parsed)) {
    writeCompatMarker(basePath, parsed);
  }

  if (!isValidCompatMarker(parsed)) {
    if (quarantineInvalid) quarantine(basePath, raw);
    return emptyMarker();
  }
  // Promote older markers by defaulting absent fields. Schema 1 → 2 only adds
  // the optional `planning` field; treat its absence as planning-inactive so
  // existing PR #802 users upgrade transparently. (A future schema 3 would
  // need an explicit migration here; for now anything that passes validation
  // is safe to read.)
  if (!parsed.planning) {
    parsed.planning = { active: false, layout: null, projections: {}, passthrough: {} };
  }
  return parsed;
}

/**
 * Fresh deep copy of EMPTY_MARKER. Callers mutate the returned `projections`
 * object (e.g. repair refreshes an entry), so a shallow copy would share the
 * reference and pollute the module constant across calls. Always deep-copy.
 */
function emptyMarker(): CompatMarker {
  return {
    schema: EMPTY_MARKER.schema,
    lastWriter: EMPTY_MARKER.lastWriter,
    lastProjectedAt: EMPTY_MARKER.lastProjectedAt,
    projections: {},
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: EMPTY_MARKER.piVersion,
  };
}

/**
 * Write the marker atomically (write-temp then rename) so a crash mid-write
 * can't leave a half-written file that next startup would quarantine.
 */
export function writeCompatMarker(basePath: string, marker: CompatMarker): void {
  const path = compatMarkerPath(basePath);
  atomicWriteSync(path, JSON.stringify(marker, null, 2));
}

export function recordCompatProjectionWrite(
  basePath: string,
  filePath: string,
  content: string,
  entities: string[],
): void {
  const projectionPath = deriveCompatProjectionKey(filePath, [join(basePath, ".gsd")]);
  // Projection keys are resolved under .gsd; never persist one that escapes
  // that root.
  if (!isSafeProjectionKey(projectionPath)) return;
  const marker = readCompatMarker(basePath);
  marker.projections[projectionPath] = {
    sha: computeProjectionSha(content),
    entities,
  };
  marker.lastWriter = "gsd-pi";
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(basePath, marker);
}

/**
 * Remove projection entries whose backing file no longer exists on disk.
 *
 * gsd-pi never deletes marker entries on its own: both drift detectors skip
 * files missing from disk (`if (!existsSync(abs)) continue;`) and the write-time
 * flush only ever adds or refreshes entries. So when a phase directory is
 * renamed or removed (e.g. `phases/29-new-milestone-m029/` →
 * `phases/29-frontend-code-debt-cleanup/`), the old projection paths linger in
 * `.compat.json` forever as phantom entries pointing at directories that no
 * longer exist (#1257). They never reconcile, and `.compat.json` keeps drifting
 * from disk reality so `git status` stops being a reliable proxy for "did the
 * engine touch my plans?".
 *
 * This prunes those orphaned entries across the `.gsd/` projections and the
 * `.planning/` projections/passthrough maps. It is safe: a missing-file entry is
 * inert (every detector already ignores it), and if the file is later
 * re-projected the write-time flush / unseeded-file detection re-seeds an
 * accurate baseline.
 *
 * Returns the number of entries removed; when nothing is orphaned the marker is
 * left untouched (no needless write, no `lastProjectedAt` churn).
 */
export function pruneOrphanedProjectionEntries(basePath: string): number {
  if (!existsSync(compatMarkerPath(basePath))) return 0;

  const marker = readCompatMarker(basePath);
  let removed = 0;

  const pruneMap = (map: Record<string, ProjectionEntry>, root: string): void => {
    for (const relPath of Object.keys(map)) {
      if (!existsSync(join(basePath, root, relPath))) {
        delete map[relPath];
        removed++;
      }
    }
  };

  pruneMap(marker.projections, ".gsd");
  if (marker.planning) {
    pruneMap(marker.planning.projections, ".planning");
    pruneMap(marker.planning.passthrough, ".planning");
  }

  if (removed > 0) writeCompatMarker(basePath, marker);
  return removed;
}

function quarantine(basePath: string, raw: string): void {
  const path = compatMarkerPath(basePath);
  const badPath = `${path}.bad-${Date.now()}`;
  try {
    mkdirSync(dirname(badPath), { recursive: true });
    try {
      renameSync(path, badPath);
    } catch {
      writeFileSync(badPath, raw, "utf-8");
      unlinkSync(path);
    }
  } catch {
    // Best-effort: if we can't quarantine, leave the original in place — next
    // read will quarantine. Never throw out of marker I/O.
  }
}

function healMarkerProjectionKeys(basePath: string, marker: unknown): marker is CompatMarker {
  if (typeof marker !== "object" || marker === null) return false;
  const m = marker as Record<string, unknown>;
  let changed = false;

  if (typeof m.projections === "object" && m.projections !== null) {
    changed = healProjectionMapKeys(basePath, ".gsd", m.projections as Record<string, ProjectionEntry>) || changed;
  }

  const planning = m.planning;
  if (typeof planning === "object" && planning !== null) {
    const p = planning as Record<string, unknown>;
    if (typeof p.projections === "object" && p.projections !== null) {
      changed = healProjectionMapKeys(basePath, ".planning", p.projections as Record<string, ProjectionEntry>) || changed;
    }
    if (typeof p.passthrough === "object" && p.passthrough !== null) {
      changed = healProjectionMapKeys(basePath, ".planning", p.passthrough as Record<string, ProjectionEntry>) || changed;
    }
  }

  return changed;
}

function healProjectionMapKeys(
  basePath: string,
  rootName: ".gsd" | ".planning",
  map: Record<string, ProjectionEntry>,
): boolean {
  let changed = false;
  const root = join(basePath, rootName);

  for (const key of Object.keys(map)) {
    if (isSafeProjectionKey(key)) continue;
    // Unfixable key — control chars/absolute/drive-letter, or still escaping
    // after canonicalization: drop it instead of leaving it in place, where it
    // would invalidate the whole marker on every subsequent read (#2130).
    const unfixable = key.includes("\0") || isAbsolute(key) || /^[A-Za-z]:/.test(key);
    const healedKey = unfixable ? null : rootRelativeKey(root, resolve(root, key));
    if (!healedKey || !isSafeProjectionKey(healedKey)) {
      delete map[key];
      changed = true;
      continue;
    }

    if (!map[healedKey]) {
      map[healedKey] = map[key]!;
    }
    delete map[key];
    changed = true;
  }

  return changed;
}
