/**
 * Milestone ID primitives — pure utilities for generating, parsing, sorting,
 * and discovering milestone identifiers.
 *
 * Consumed by 15+ modules across the GSD extension. Zero side-effects.
 */

import { randomInt } from "node:crypto";
import { join } from "node:path";
import { logWarning } from "./workflow-logger.js";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { milestonesDir, gsdProjectionRoot } from "./paths.js";
import { LAYOUT_SEGMENTS } from "./layout-policy.js";
import { loadQueueOrder, sortByQueueOrder } from "./queue-order.js";
import { getErrorMessage } from "./error-utils.js";

// ─── Regex ──────────────────────────────────────────────────────────────────

/** Matches both classic `M001` and unique `M001-abc123` formats (anchored). */
export const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;

function normalizeDiscussMilestoneId(id: string): string {
  const m = id.trim().match(/^m(\d{3})(?:-([a-z0-9]{6}))?$/i);
  if (!m) return id.trim();
  return m[2] ? `M${m[1]}-${m[2].toLowerCase()}` : `M${m[1]}`;
}

function normalizeDiscussSliceId(id: string): string {
  const m = id.trim().match(/^s(\d{2})$/i);
  if (!m) return id.trim();
  return `S${m[1]}`;
}

/** Canonicalize milestone/slice IDs from `/gsd discuss` targeting args. */
export function normalizeDiscussTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return trimmed;
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return normalizeDiscussMilestoneId(trimmed);
  const mid = normalizeDiscussMilestoneId(trimmed.slice(0, slash));
  const rest = trimmed.slice(slash + 1);
  const nextSlash = rest.indexOf("/");
  if (nextSlash > 0) {
    const sid = normalizeDiscussSliceId(rest.slice(0, nextSlash));
    return `${mid}/${sid}${rest.slice(nextSlash)}`;
  }
  return `${mid}/${normalizeDiscussSliceId(rest)}`;
}

// ─── Parsing & Extraction ───────────────────────────────────────────────────

/** Extract the trailing sequential number from a milestone ID. Returns 0 for non-matches. */
export function extractMilestoneSeq(id: string): number {
  const m = id.match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Structured parse of a milestone ID into optional suffix and sequence number. */
export function parseMilestoneId(id: string): { suffix?: string; num: number } {
  const m = id.match(/^M(\d{3})(?:-([a-z0-9]{6}))?$/);
  if (!m) return { num: 0 };
  return {
    ...(m[2] ? { suffix: m[2] } : {}),
    num: parseInt(m[1], 10),
  };
}

// ─── Sorting ────────────────────────────────────────────────────────────────

/** Comparator for sorting milestone IDs by sequential number. */
export function milestoneIdSort(a: string, b: string): number {
  return extractMilestoneSeq(a) - extractMilestoneSeq(b);
}

// ─── Generation ─────────────────────────────────────────────────────────────

/** Generate a 6-char lowercase `[a-z0-9]` suffix using crypto.randomInt(). */
export function generateMilestoneSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[randomInt(36)];
  }
  return result;
}

/** Return the highest numeric suffix among milestone IDs (0 when the list is empty or has no numeric IDs). */
export function maxMilestoneNum(milestoneIds: string[]): number {
  return milestoneIds.reduce((max, id) => {
    const num = extractMilestoneSeq(id);
    return num > max ? num : max;
  }, 0);
}

/** Derive the next milestone ID from existing IDs using max-based approach to avoid collisions after deletions. */
export function nextMilestoneId(milestoneIds: string[], uniqueEnabled?: boolean): string {
  const seq = String(maxMilestoneNum(milestoneIds) + 1).padStart(3, "0");
  if (uniqueEnabled) {
    return `M${seq}-${generateMilestoneSuffix()}`;
  }
  return `M${seq}`;
}

// ─── Reservation ─────────────────────────────────────────────────────────────

/**
 * Module-level set of milestone IDs that have been previewed/promised to the
 * user but not yet materialised on disk. Both guided-flow (preview) and
 * gsd_milestone_generate_id (tool) share this set so the ID shown in the UI
 * matches the one the tool returns.
 */
const reservedMilestoneIds = new Set<string>();

/** Reserve an ID so that subsequent calls to `claimReservedId` / `nextMilestoneId` account for it. */
export function reserveMilestoneId(id: string): void {
  reservedMilestoneIds.add(id);
}

/**
 * If any IDs have been reserved, shift one out and return it.
 * Returns `undefined` when the reservation set is empty.
 */
export function claimReservedId(): string | undefined {
  const first = reservedMilestoneIds.values().next().value;
  if (first !== undefined) {
    reservedMilestoneIds.delete(first);
    return first;
  }
  return undefined;
}

/** Return a snapshot of all currently reserved IDs (for merging into the "existing" list). */
export function getReservedMilestoneIds(): ReadonlySet<string> {
  return reservedMilestoneIds;
}

/** Clear all reservations (useful for tests). */
export function clearReservedMilestoneIds(): void {
  reservedMilestoneIds.clear();
}

// ─── Discovery ──────────────────────────────────────────────────────────────

function scanMilestoneIdsFromDir(basePath: string, dir: string): string[] {
  const legacyNumericIds = idsWithLegacyNumericDirs(basePath);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      // Legacy layout: exact M001 or M001-abcdef directory name
      if (MILESTONE_ID_RE.test(d.name)) {
        return d.name;
      }
      // Legacy recovery/imports may contain bare numeric milestone directories
      // (for example `milestones/15/15-ROADMAP.md`). The DB can preserve that
      // id, and rebuild renders it, so drift scans must see it too.
      if (/^\d+$/.test(d.name)) {
        return d.name;
      }
      // Legacy layout: M001-abcdef-slug descriptor directories
      const legacyMatch = d.name.match(/^(M\d{3}(?:-[a-z0-9]{6})?)-/);
      if (legacyMatch) {
        return legacyMatch[1]!;
      }
      // Flat-phase layout: NN-slug → M00N (slug may encode M00N or M00N-abcdef)
      const flatMatch = d.name.match(/^(\d+)-(.+)$/);
      if (flatMatch) {
        const phaseNum = parseInt(flatMatch[1]!, 10);
        const rest = flatMatch[2]!;
        const fromSlug = normalizeDiscussMilestoneId(rest);
        if (MILESTONE_ID_RE.test(fromSlug)) {
          return fromSlug;
        }
        const headingId = milestoneIdFromPhaseDirHeading(join(dir, d.name), phaseNum);
        if (headingId) {
          return headingId;
        }
        const numericId = String(phaseNum);
        if (legacyNumericIds.has(numericId)) {
          return numericId;
        }
        return `M${String(phaseNum).padStart(3, "0")}`;
      }
      return null;
    })
    .filter((id): id is string => id !== null);
}

/**
 * Read the canonical suffixed milestone ID from a flat-phase directory's own
 * ROADMAP/SUMMARY markdown heading (`# M00N-suffix: Title`), when present.
 * This support handling same milestone IDs with different unique ids.
 * Returns null when no phase file carries a matching heading — callers fall
 * back to the bare M00N form in that case.
 */
function milestoneIdFromPhaseDirHeading(phaseDirPath: string, phaseNum: number): string | null {
  const expectedNum = String(phaseNum).padStart(3, "0");
  const headingRe = new RegExp(`^#\\s+(M${expectedNum}(?:-[a-z0-9]{6})?)\\b`, "m");
  let entries: string[];
  try {
    entries = readdirSync(phaseDirPath);
  } catch (err) {
    // A missing/unreadable phase dir here is expected during traversal races
    // (directory removed between listing and stat) and is not this helper's
    // failure to report — the caller already handles a null return by
    // falling back to the bare M00N form. Only a genuinely existing-but-
    // unreadable directory is surprising enough to warn about.
    if (existsSync(phaseDirPath)) {
      logWarning("engine", `milestoneIdFromPhaseDirHeading: ${phaseDirPath} exists but readdirSync failed — ${getErrorMessage(err)}`);
    }
    return null;
  }
  const candidates = entries
    .filter((name) => /-(ROADMAP|SUMMARY)\.md$/.test(name))
    .sort((a, b) => (a.endsWith("ROADMAP.md") === b.endsWith("ROADMAP.md") ? 0 : a.endsWith("ROADMAP.md") ? -1 : 1));
  for (const name of candidates) {
    const candidatePath = join(phaseDirPath, name);
    try {
      const content = readFileSync(candidatePath, "utf-8");
      const match = content.match(headingRe);
      if (match) return match[1]!;
    } catch (err) {
      // Unreadable candidate file: try the next one, but still surface a
      // warning — a heading-bearing file that cannot be read silently
      // degrades this milestone to the ambiguous bare-M00N fallback.
      logWarning("engine", `milestoneIdFromPhaseDirHeading: ${candidatePath} exists but readFileSync failed — ${getErrorMessage(err)}`);
    }
  }
  return null;
}

function idsWithLegacyNumericDirs(basePath: string): Set<string> {
  const legacyDir = join(gsdProjectionRoot(basePath), "milestones");
  const ids = new Set<string>();
  try {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) ids.add(entry.name);
    }
  } catch (err) {
    // A missing legacy directory is the common, benign case (nothing to
    // consult). Only surface a real failure when the directory exists but
    // could not be read.
    if (existsSync(legacyDir)) {
      logWarning("engine", `idsWithLegacyNumericDirs: ${legacyDir} exists but readdirSync failed — ${getErrorMessage(err)}`);
    }
  }
  return ids;
}

/** Scan the milestones directory and return IDs sorted by queue order (or numeric fallback). */
export function findMilestoneIds(basePath: string): string[] {
  const root = gsdProjectionRoot(basePath);
  const dirs = [milestonesDir(basePath)];
  const legacyDir = join(root, "milestones");
  if (legacyDir !== dirs[0] && existsSync(legacyDir)) dirs.push(legacyDir);
  const phasesDir = join(root, LAYOUT_SEGMENTS.level1);
  if (phasesDir !== dirs[0] && existsSync(phasesDir)) dirs.push(phasesDir);

  const ids = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const id of scanMilestoneIdsFromDir(basePath, dir)) ids.add(id);
    } catch (err) {
      if (existsSync(dir)) {
        logWarning("engine", `findMilestoneIds: ${dir} exists but readdirSync failed — ${getErrorMessage(err)}`);
      }
    }
  }

  const customOrder = loadQueueOrder(basePath);
  return sortByQueueOrder([...ids], customOrder);
}
