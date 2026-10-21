// GSD Markdown Importer
// Parses DECISIONS.md, REQUIREMENTS.md, and hierarchy artifacts from a .gsd/ tree,
// then upserts everything into the SQLite database.
//
// Exports: parseDecisionsTable, parseRequirementsSections, migrateFromMarkdown
//
// ⚠ TEST-ONLY EXPORTS — DO NOT WIRE INTO PRODUCTION PATHS ⚠
// `migrateHierarchyToDb` and `migrateFromMarkdown` are an UNCONSENTED,
// UNVERIFIED markdown→DB write path. Every production markdown→DB import MUST
// go through the crash-safe Import Application (workflow_import_applications),
// which stages, hashes, and fences the write before applying it. These two
// functions bypass all of that and currently have ZERO production callers —
// they exist solely so test scaffolding can exercise legacy import semantics.
// Guarded by tests/implicit-import-startup-authority.test.ts ("no production
// module imports the legacy markdown importer"). Do not import this module
// from any non-test file; extend the Import Application instead.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import type { Requirement } from './types.js';
import {
  upsertDecision,
  upsertRequirement,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  transaction,
  updateMilestoneStatus,
  updateSliceStatus,
  getMilestoneSlices,
  getSliceTasks,
  _getAdapter,
} from './gsd-db.js';
import { openWorkflowDatabasePath } from './db-workspace.js';
import {
  resolveGsdRootFile,
  resolveMilestoneFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTasksDir,
  legacyMilestonesDir,
  gsdRoot,
  resolveTaskFiles,
  resolveTaskFile,
  resolveMilestonePath,
} from './paths.js';
import { findMilestoneIds } from './guided-flow.js';
import { milestoneIdToPhaseNum } from './layout-policy.js';
import { stripIdPrefix } from './strip-id-prefix.js';
import { parseProjectionRoadmap as parseRoadmap, parseProjectionPlan as parsePlan } from './schemas/parsers.js';
import { parseContextDependsOn, parseSummary } from './files.js';
import { logWarning } from './workflow-logger.js';
import { parseDecisionsTable } from './decision-markdown-parser.js';

export { parseDecisionsTable } from './decision-markdown-parser.js';

// ─── DECISIONS.md Parser ───────────────────────────────────────────────────

const IMPORT_COMPLETE_STATUSES = new Set(['complete', 'done']);

function adoptedHierarchyKeys(milestoneId: string): Set<string> {
  const adapter = _getAdapter();
  if (!adapter) return new Set();
  const rows = adapter.prepare(`
    SELECT item_kind, slice_id, task_id
    FROM workflow_item_lifecycles
    WHERE project_id = (SELECT project_id FROM project_authority WHERE singleton = 1)
      AND milestone_id = :milestone_id
      AND item_kind IN ('milestone', 'slice', 'task')
  `).all({ ":milestone_id": milestoneId }) as Array<Record<string, unknown>>;
  const keys = new Set<string>();
  for (const row of rows) {
    if (row["item_kind"] === "milestone") {
      keys.add("milestone");
    } else if (row["item_kind"] === "task") {
      keys.add(`task:${String(row["slice_id"])}/${String(row["task_id"])}`);
    } else {
      keys.add(`slice:${String(row["slice_id"])}`);
    }
  }
  return keys;
}

/**
 * Derive the set of milestone ids a projection entry's `entities` touch. Marker
 * entity ids are fully-qualified DB ids (`M001`, `M001/S01`, `M001/S01/T01`), so
 * the milestone id is always the first `/`-segment — independent of the on-disk
 * layout (legacy `milestones/<MID>/…` vs flat `phases/NN-slug/…`). The
 * external-edit drift repairs (#027) feed this into
 * `migrateHierarchyToDb(..., { statusAuthoritativeMilestones })` to scope status
 * authority to exactly the milestone(s) a drifted file projects. Empty/blank
 * entries are dropped, so an entity-less entry yields an empty set (repair then
 * preserves DB status everywhere — fail toward the DB, not markdown).
 */
export function milestoneIdsFromEntities(entities: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entities) {
    const milestoneId = e.split('/')[0];
    if (milestoneId) ids.add(milestoneId);
  }
  return ids;
}

/**
 * Completion timestamp for an entity imported as complete: the SUMMARY.md mtime
 * when one exists (deterministic, matches the completion drift handler), else
 * the import time. Crucially this never returns null, so a complete entity is
 * never left with completed_at=null — which would otherwise be permanent,
 * undetectable drift when no SUMMARY file is present.
 */
function importCompletionTimestamp(summaryPath: string | null): string {
  if (summaryPath && existsSync(summaryPath)) {
    try {
      return statSync(summaryPath).mtime.toISOString();
    } catch (err) {
      // Fall through to import time.
      logWarning('projection', `summary mtime read failed for ${summaryPath}: ${(err as Error).message}`);
    }
  }
  return new Date().toISOString();
}

// ─── REQUIREMENTS.md Parser ────────────────────────────────────────────────

const STATUS_SECTIONS: Record<string, string> = {
  '## active': 'active',
  '## validated': 'validated',
  '## deferred': 'deferred',
  '## out of scope': 'out-of-scope',
};

/**
 * Parse REQUIREMENTS.md into Requirement objects.
 * Finds section headings (## Active, ## Validated, ## Deferred, ## Out of Scope),
 * then within each section finds ### RXXX — Title blocks and extracts bullet fields.
 */
export function parseRequirementsSections(content: string): Requirement[] {
  const lines = content.split('\n');
  const results: Requirement[] = [];

  let currentSectionStatus: string | null = null;
  let currentReq: Partial<Requirement> | null = null;
  let currentFullContentLines: string[] = [];

  function flushReq(): void {
    if (currentReq && currentReq.id) {
      currentReq.full_content = currentFullContentLines.join('\n').trim();
      results.push({
        id: currentReq.id!,
        class: currentReq.class ?? '',
        status: currentReq.status ?? currentSectionStatus ?? '',
        description: currentReq.description ?? '',
        why: currentReq.why ?? '',
        source: currentReq.source ?? '',
        primary_owner: currentReq.primary_owner ?? '',
        supporting_slices: currentReq.supporting_slices ?? '',
        validation: currentReq.validation ?? '',
        notes: currentReq.notes ?? '',
        full_content: currentReq.full_content ?? '',
        superseded_by: currentReq.superseded_by ?? null,
      });
    }
    currentReq = null;
    currentFullContentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.trim().toLowerCase();

    // Check for section heading (## Active, ## Validated, etc.)
    if (lineLower.startsWith('## ')) {
      flushReq();
      const matchedSection = Object.entries(STATUS_SECTIONS).find(
        ([prefix]) => lineLower === prefix || lineLower.startsWith(prefix + ' ')
      );
      if (matchedSection) {
        currentSectionStatus = matchedSection[1];
      } else {
        // Sections like ## Traceability, ## Coverage Summary — stop parsing requirements
        currentSectionStatus = null;
      }
      continue;
    }

    // Check for requirement heading (### RXXX — Title or ### NET-01 — Title)
    const reqMatch = line.match(/^###\s+([A-Z][A-Z0-9]*-\d+|R\d+)\s*[—–-]\s*(.+)/i);
    if (reqMatch) {
      flushReq();
      if (currentSectionStatus !== null) {
        currentReq = {
          id: reqMatch[1],
          status: currentSectionStatus,
        };
        currentFullContentLines = [line];
      }
      continue;
    }

    // If we're inside a requirement block, collect content and extract bullets
    if (currentReq && currentSectionStatus !== null) {
      currentFullContentLines.push(line);

      // Extract field bullets: "- Field: value" or "- Field name: value"
      const bulletMatch = line.match(/^-\s+(.+?):\s+(.*)/);
      if (bulletMatch) {
        const fieldName = bulletMatch[1].trim().toLowerCase();
        const value = bulletMatch[2].trim();

        switch (fieldName) {
          case 'class':
            currentReq.class = value;
            break;
          case 'status':
            // Bullet status takes precedence over section heading
            currentReq.status = value;
            break;
          case 'description':
            currentReq.description = value;
            break;
          case 'why it matters':
          case 'why':
            currentReq.why = value;
            break;
          case 'source':
            currentReq.source = value;
            break;
          case 'primary owning slice':
          case 'primary owner':
          case 'primary_owner':
            currentReq.primary_owner = value;
            break;
          case 'supporting slices':
          case 'supporting_slices':
            currentReq.supporting_slices = value;
            break;
          case 'validation':
          case 'validated by':
            currentReq.validation = value;
            break;
          case 'notes':
            currentReq.notes = value;
            break;
          case 'proof':
            // In validated section, "Proof:" serves as notes
            currentReq.notes = value;
            break;
        }
      }
    }
  }

  flushReq();

  // Deduplicate by ID: if a requirement appears in both Active and Validated sections,
  // keep the fuller entry (typically Active) and merge in any non-empty fields from later entries.
  const deduped = new Map<string, Requirement>();
  for (const req of results) {
    const existing = deduped.get(req.id);
    if (!existing) {
      deduped.set(req.id, req);
    } else {
      // Merge: non-empty fields from later entry override empty fields in existing
      for (const key of Object.keys(req) as (keyof Requirement)[]) {
        if (key === 'id' || key === 'superseded_by') continue;
        const val = req[key];
        if (val && val !== '' && (!existing[key] || existing[key] === '')) {
          (existing as unknown as Record<string, unknown>)[key] = val;
        }
      }
    }
  }

  return Array.from(deduped.values());
}

// ─── Import Functions ──────────────────────────────────────────────────────

/**
 * Import decisions from DECISIONS.md into the database.
 * Handles supersession chains.
 */
function importDecisions(gsdDir: string): number {
  const filePath = resolveGsdRootFile(gsdDir, 'DECISIONS');
  if (!existsSync(filePath)) return 0;

  const content = readFileSync(filePath, 'utf-8');
  const decisions = parseDecisionsTable(content);

  for (const d of decisions) {
    upsertDecision(d);
  }

  return decisions.length;
}

/**
 * Import requirements from REQUIREMENTS.md into the database.
 */
function importRequirements(gsdDir: string): number {
  const filePath = resolveGsdRootFile(gsdDir, 'REQUIREMENTS');
  if (!existsSync(filePath)) return 0;

  const content = readFileSync(filePath, 'utf-8');
  const requirements = parseRequirementsSections(content);

  for (const r of requirements) {
    upsertRequirement(r);
  }

  return requirements.length;
}

// ─── Hierarchy Artifact Walker ─────────────────────────────────────────────

/** Artifact suffixes to look for at each hierarchy level */
const MILESTONE_SUFFIXES = ['ROADMAP', 'CONTEXT', 'RESEARCH', 'ASSESSMENT', 'SUMMARY', 'VALIDATION'];
const SLICE_SUFFIXES = ['PLAN', 'SUMMARY', 'RESEARCH', 'CONTEXT', 'CONTEXT-DRAFT', 'ASSESSMENT', 'UAT', 'CONTINUE'];
const TASK_SUFFIXES = ['PLAN', 'SUMMARY', 'CONTINUE', 'CONTEXT', 'RESEARCH'];

/**
 * Import hierarchy artifacts (roadmaps, plans, summaries, etc.) from the .gsd/ tree.
 * Walks milestones → slices → tasks directories.
 */
function importHierarchyArtifacts(gsdDir: string): number {
  let count = 0;
  const gsdPath = gsdRoot(gsdDir);

  // Root-level artifacts: PROJECT.md, QUEUE.md
  const rootFiles = ['PROJECT.md', 'QUEUE.md', 'SECRETS-MANIFEST.md'];
  for (const fileName of rootFiles) {
    const filePath = join(gsdPath, fileName);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const artifactType = fileName.replace('.md', '').replace('-', '_');
      insertArtifact({
        path: fileName,
        artifact_type: artifactType,
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: content,
      });
      count++;
    }
  }

  // Walk phases (flat-phase layout: phases/NN-slug/, legacy: milestones/M001/)
  const milestoneIds = findMilestoneIds(gsdDir);
  const legacyDir = legacyMilestonesDir(gsdDir);

  for (const milestoneId of milestoneIds) {
    // Use resolveMilestonePath so canonical-name / newest-dir selection matches
    // the same logic used by the renderer and reconciler, preventing import and
    // render from landing on different phase trees for the same milestone.
    const resolvedPhaseFullPath = resolveMilestonePath(gsdDir, milestoneId);

    if (!resolvedPhaseFullPath) {
      // Last resort: findDirByPrefix for legacy dirs
      const milestoneDirName = findDirByPrefix(legacyDir, milestoneId);
      if (!milestoneDirName) continue;
      count += importLegacyMilestoneArtifacts(
        join(legacyDir, milestoneDirName),
        milestoneDirName,
        milestoneId,
      );
      continue;
    }

    // Determine if this is a legacy (milestones/) or flat-phase (phases/) dir.
    const legacyDirNorm = legacyDir.replace(/\\/g, "/");
    const resolvedNorm = resolvedPhaseFullPath.replace(/\\/g, "/");
    const isLegacyResolved = resolvedNorm.startsWith(legacyDirNorm + "/") || resolvedNorm === legacyDirNorm;

    const phaseDirName = basename(resolvedPhaseFullPath);
    if (isLegacyResolved) {
      count += importLegacyMilestoneArtifacts(resolvedPhaseFullPath, phaseDirName, milestoneId);
      continue;
    }
    const phaseFullPath = resolvedPhaseFullPath;
    const phaseNum = milestoneIdToPhaseNum(milestoneId);

    // Phase-level files (flat-phase: NN-SUFFIX.md, legacy: M001-SUFFIX.md)
    const phasePrefix = `${String(phaseNum).padStart(2, "0")}`;
    const artifactBase = `phases/${phaseDirName}`;
    let phaseArtifacts = importFilesAtLevel(
      phaseFullPath,
      phasePrefix,
      MILESTONE_SUFFIXES,
      artifactBase,
      milestoneId,
      null,
      null,
    );
    if (phaseArtifacts === 0) {
      phaseArtifacts = importFilesAtLevel(
        phaseFullPath,
        milestoneId,
        MILESTONE_SUFFIXES,
        artifactBase,
        milestoneId,
        null,
        null,
      );
    }
    count += phaseArtifacts;

    // Flat-phase: plan files are NN-MM-SUFFIX.md inside the phase dir.
    // Also check legacy slices/ subdir for backward compat.
    const planFiles = readdirSync(phaseFullPath, { withFileTypes: true })
      .filter(f => f.isFile() && /^\d+-\d+-/.test(f.name))
      .map(f => f.name)
      .sort();

    for (const planFile of planFiles) {
      const planMatch = planFile.match(/^\d+-(\d+)-([A-Z0-9-]+)\.md$/i);
      if (!planMatch) continue;
      const planNum = parseInt(planMatch[1]!, 10);
      const sliceId = `S${String(planNum).padStart(2, '0')}`;
      const suffix = planMatch[2]!.toUpperCase();
      const filePath = join(phaseFullPath, planFile);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf-8');
      insertArtifact({
        path: `${artifactBase}/${planFile}`,
        artifact_type: suffix,
        milestone_id: milestoneId,
        slice_id: sliceId,
        task_id: null,
        full_content: content,
      });
      count++;
    }

    // Legacy fallback: walk slices/ subdir if it exists
    const slicesDir = join(phaseFullPath, 'slices');
    if (existsSync(slicesDir)) {
      const sliceDirs = readdirSync(slicesDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^S\d+/.test(d.name))
        .map(d => d.name)
        .sort();

      for (const sliceDirName of sliceDirs) {
        const sliceId = sliceDirName.match(/^(S\d+)/)?.[1] ?? sliceDirName;
        const sliceFullPath = join(slicesDir, sliceDirName);

        count += importFilesAtLevel(
          sliceFullPath,
          sliceId,
          SLICE_SUFFIXES,
          `phases/${phaseDirName}/slices/${sliceDirName}`,
          milestoneId,
          sliceId,
          null,
        );

        // Legacy tasks walk
        const tasksDir = join(sliceFullPath, 'tasks');
        if (!existsSync(tasksDir)) continue;

        for (const suffix of TASK_SUFFIXES) {
          const taskFiles = resolveTaskFiles(tasksDir, suffix);
          for (const taskFileName of taskFiles) {
            const taskId = taskFileName.match(/^(T\d+)/)?.[1] ?? null;
            const taskFilePath = join(tasksDir, taskFileName);
            if (!existsSync(taskFilePath)) continue;

            const content = readFileSync(taskFilePath, 'utf-8');
            const relPath = `phases/${phaseDirName}/slices/${sliceDirName}/tasks/${taskFileName}`;

            insertArtifact({
              path: relPath,
              artifact_type: suffix,
              milestone_id: milestoneId,
              slice_id: sliceId,
              task_id: taskId,
              full_content: content,
            });
            count++;
          }
        }
      }
    }

    // Partial migration may leave nested milestones/M00N/ content alongside phases/.
    const milestoneDirName = findDirByPrefix(legacyDir, milestoneId);
    if (milestoneDirName) {
      count += importLegacyMilestoneArtifacts(
        join(legacyDir, milestoneDirName),
        milestoneDirName,
        milestoneId,
      );
    }
  }

  return count;
}

/** Walk a pre-flat-phase milestones/M001/ tree when no phases/NN-slug dir exists. */
function importLegacyMilestoneArtifacts(
  milestoneFullPath: string,
  milestoneDirName: string,
  milestoneId: string,
): number {
  let count = 0;

  count += importFilesAtLevel(
    milestoneFullPath,
    milestoneId,
    MILESTONE_SUFFIXES,
    `milestones/${milestoneDirName}`,
    milestoneId,
    null,
    null,
  );

  const slicesDir = join(milestoneFullPath, 'slices');
  if (!existsSync(slicesDir)) return count;

  const sliceDirs = readdirSync(slicesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^S\d+/.test(d.name))
    .map(d => d.name)
    .sort();

  for (const sliceDirName of sliceDirs) {
    const sliceId = sliceDirName.match(/^(S\d+)/)?.[1] ?? sliceDirName;
    const sliceFullPath = join(slicesDir, sliceDirName);

    count += importFilesAtLevel(
      sliceFullPath,
      sliceId,
      SLICE_SUFFIXES,
      `milestones/${milestoneDirName}/slices/${sliceDirName}`,
      milestoneId,
      sliceId,
      null,
    );

    const tasksDir = join(sliceFullPath, 'tasks');
    if (!existsSync(tasksDir)) continue;

    for (const suffix of TASK_SUFFIXES) {
      const taskFiles = resolveTaskFiles(tasksDir, suffix);
      for (const taskFileName of taskFiles) {
        const taskId = taskFileName.match(/^(T\d+)/)?.[1] ?? null;
        const taskFilePath = join(tasksDir, taskFileName);
        if (!existsSync(taskFilePath)) continue;

        const content = readFileSync(taskFilePath, 'utf-8');
        const relPath = `milestones/${milestoneDirName}/slices/${sliceDirName}/tasks/${taskFileName}`;

        insertArtifact({
          path: relPath,
          artifact_type: suffix,
          milestone_id: milestoneId,
          slice_id: sliceId,
          task_id: taskId,
          full_content: content,
        });
        count++;
      }
    }
  }

  return count;
}

/**
 * Import files at a specific hierarchy level (milestone or slice).
 */
function importFilesAtLevel(
  dirPath: string,
  idPrefix: string,
  suffixes: string[],
  relativeBase: string,
  milestoneId: string,
  sliceId: string | null,
  taskId: string | null,
): number {
  let count = 0;

  for (const suffix of suffixes) {
    // Try ID-SUFFIX.md pattern (e.g., M001-ROADMAP.md, S01-PLAN.md)
    const fileName = findFileByPrefixAndSuffix(dirPath, idPrefix, suffix);
    if (!fileName) continue;

    const filePath = join(dirPath, fileName);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const relPath = `${relativeBase}/${fileName}`;

    insertArtifact({
      path: relPath,
      artifact_type: suffix,
      milestone_id: milestoneId,
      slice_id: sliceId,
      task_id: taskId,
      full_content: content,
    });
    count++;
  }

  return count;
}

/**
 * Find a directory by ID prefix within a parent directory.
 */
function findDirByPrefix(parentDir: string, idPrefix: string): string | null {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    // Exact match first
    const exact = entries.find(e => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    // Prefix match for legacy
    const prefixed = entries.find(e => e.isDirectory() && e.name.startsWith(idPrefix + '-'));
    return prefixed ? prefixed.name : null;
  } catch {
    return null;
  }
}

/**
 * Find a file by ID prefix and suffix within a directory.
 * Matches ID-SUFFIX.md or ID-*-SUFFIX.md patterns.
 */
function findFileByPrefixAndSuffix(dir: string, idPrefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir);
    // Direct: ID-SUFFIX.md
    const target = `${idPrefix}-${suffix}.md`.toUpperCase();
    const direct = entries.find(e => e.toUpperCase() === target);
    if (direct) return direct;
    // Legacy: ID-DESCRIPTOR-SUFFIX.md — exclude double-numbered (NN-NN-*) slice
    // files so a phase-prefix like "01" never matches a slice file "01-01-SUMMARY.md".
    const pattern = new RegExp(`^${idPrefix}-.*-${suffix}\\.md$`, 'i');
    const match = entries.find(e => pattern.test(e) && !/^\d+-\d+-/.test(e));
    return match ?? null;
  } catch {
    return null;
  }
}

// ─── Hierarchy Migration (milestones/slices/tasks from roadmaps+plans) ────

/**
 * Walk .gsd/milestones/ dirs, parse roadmaps and plans, and populate
 * the milestones/slices/tasks DB tables.
 *
 * - Milestone title: from roadmap H1 (e.g. "# M001: Title") or CONTEXT.md
 * - Milestone status: 'complete' if SUMMARY exists, 'parked' if PARKED exists, else 'active'
 * - Milestone depends_on: from CONTEXT.md frontmatter
 * - Slice metadata: from parseRoadmap() — id, title, risk, depends, done, demo
 * - Task metadata: from parsePlan() — id, title, done, estimate
 *
 * Uses INSERT OR IGNORE for idempotency. Insert order: milestones → slices → tasks.
 * Ghost milestones (dirs with no CONTEXT, ROADMAP, or SUMMARY) are skipped.
 *
 * `opts.statusAuthoritativeMilestones` narrows *status* authority. It exists for
 * the scoped external-edit drift repair: detection knows exactly which
 * projection file drifted, but this import walks the whole tree. Without scoping,
 * an unrelated file that is stale from gsd-pi's own miss (a forgotten render)
 * rides along with markdown authority it was never granted and its stale checked
 * checkbox silently reverts a reopened slice/milestone in the DB (#027).
 *
 * - opts absent → full markdown authority for unadopted rows (initial migration
 *   and gsd-core full import). Adopted Task/Slice lifecycle
 *   state always remains DB-authoritative; markdown may refresh metadata only.
 * - opts present → for a milestone NOT in the set whose DB row *already exists*,
 *   the existing DB status is preserved: the slice upsert is fed the current DB
 *   status (so a stale `complete` checkbox can't overwrite a reopened `pending`),
 *   and the complete-status backfills are skipped. Milestone rows are already
 *   protected by INSERT OR IGNORE. Rows that do not exist yet are inserted with
 *   the parsed status regardless of scope (new content is new content).
 *
 * Returns count of inserted hierarchy items.
 *
 * TEST-ONLY: unconsented markdown→DB write path with zero production callers.
 * Production imports must go through the Import Application — see the loud
 * warning at the top of this file.
 */
export function migrateHierarchyToDb(
  basePath: string,
  opts?: { statusAuthoritativeMilestones?: ReadonlySet<string> },
): {
  milestones: number;
  slices: number;
  tasks: number;
} {
  const counts = { milestones: 0, slices: 0, tasks: 0 };
  const milestoneIds = findMilestoneIds(basePath);
  const statusScope = opts?.statusAuthoritativeMilestones;

  for (const milestoneId of milestoneIds) {
    // Check for ghost milestones — skip dirs with no meaningful content
    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, 'ROADMAP');
    const contextPath = resolveMilestoneFile(basePath, milestoneId, 'CONTEXT');
    const summaryPath = resolveMilestoneFile(basePath, milestoneId, 'SUMMARY');
    const parkedPath = resolveMilestoneFile(basePath, milestoneId, 'PARKED');

    const hasRoadmap = roadmapPath !== null && existsSync(roadmapPath);
    const hasContext = contextPath !== null && existsSync(contextPath);
    const hasSummary = summaryPath !== null && existsSync(summaryPath);
    const hasParked = parkedPath !== null && existsSync(parkedPath);

    // Ghost milestone: no CONTEXT, ROADMAP, or SUMMARY → skip
    if (!hasRoadmap && !hasContext && !hasSummary) continue;

    // Determine milestone title from roadmap H1 or CONTEXT heading
    let milestoneTitle = '';
    let roadmapContent: string | null = null;
    let roadmap: ReturnType<typeof parseRoadmap> | null = null;
    if (hasRoadmap) {
      roadmapContent = readFileSync(roadmapPath!, 'utf-8');
      roadmap = parseRoadmap(roadmapContent);
      // #1592: H1 is `${id}: ${title}`; store the title without the id prefix.
      milestoneTitle = stripIdPrefix(roadmap.title, milestoneId);
    }

    // Determine milestone status
    let milestoneStatus = 'active';
    if (hasSummary) milestoneStatus = 'complete';
    else if (hasParked) milestoneStatus = 'parked';
    // Import milestones with all-done roadmap slices as complete (#3390, #3379)
    // even when SUMMARY.md is missing — the roadmap checkboxes are authoritative.
    else if (roadmap && roadmap.slices.length > 0 && roadmap.slices.every(s => s.done)) {
      milestoneStatus = 'complete';
    }
    if (!milestoneTitle && hasContext) {
      const contextContent = readFileSync(contextPath!, 'utf-8');
      const h1Match = contextContent.match(/^#\s+(.+)/m);
      if (h1Match) milestoneTitle = stripIdPrefix(h1Match[1].trim(), milestoneId);
    }

    // Determine depends_on from CONTEXT frontmatter
    let dependsOn: string[] = [];
    if (hasContext) {
      const contextContent = readFileSync(contextPath!, 'utf-8');
      dependsOn = parseContextDependsOn(contextContent);
    }

    // Extract raw "## Boundary Map" section from roadmap markdown for planning column
    let boundaryMapSection = '';
    if (roadmapContent) {
      const bmIdx = roadmapContent.indexOf('## Boundary Map');
      if (bmIdx >= 0) {
        const afterBm = roadmapContent.slice(bmIdx);
        // Take content until next ## heading or EOF
        const nextHeading = afterBm.indexOf('\n## ', 1);
        boundaryMapSection = nextHeading >= 0 ? afterBm.slice(0, nextHeading).trim() : afterBm.trim();
      }
    }

    // #027: when a status scope is supplied, a milestone outside it keeps DB
    // status authority for rows that already exist — only the drifted file's
    // milestone(s) may drive status closes from checkboxes. T021: absent scope
    // also preserves existing DB status (unadopted checkbox-wins is gone).
    const milestoneStatusAuthoritative = Boolean(statusScope?.has(milestoneId));
    // Snapshot existing statuses so scoped imports and adopted rows can echo
    // DB authority back into metadata-only upserts.
    const adoptedKeys = adoptedHierarchyKeys(milestoneId);
    const milestoneAdopted = adoptedKeys.has("milestone");
    const milestoneHasAdoptedDescendant = [...adoptedKeys].some((key) => key !== "milestone");
    const existingSliceStatus = new Map<string, string>();
    const existingTaskStatus = new Map<string, string>();
    if (!milestoneStatusAuthoritative || adoptedKeys.size > 0) {
      for (const s of getMilestoneSlices(milestoneId)) {
        existingSliceStatus.set(s.id, s.status);
        for (const t of getSliceTasks(milestoneId, s.id)) {
          existingTaskStatus.set(`${s.id}/${t.id}`, t.status);
        }
      }
    }

    // Insert milestone (FK parent — must come first). INSERT OR IGNORE: an
    // existing milestone row is never overwritten, so DB status is already
    // preserved for out-of-scope milestones. `inserted` tells us whether this
    // row is new (parsed status applies) vs pre-existing (backfill gated below).
    const milestoneInserted = insertMilestone({
      id: milestoneId,
      title: milestoneTitle,
      status: milestoneStatus,
      depends_on: dependsOn,
      planning: {
        vision: roadmap?.vision ?? '',
        successCriteria: roadmap?.successCriteria ?? [],
        boundaryMapMarkdown: boundaryMapSection,
      },
    });
    // insertMilestone never sets completed_at; backfill it now for milestones
    // imported as complete so the DB is internally coherent immediately after
    // import (rather than relying on a later reconciliation pass that can't even
    // see the drift when no SUMMARY file exists). #027: skip the backfill for an
    // out-of-scope milestone that already existed — its DB status is authoritative.
    if (
      IMPORT_COMPLETE_STATUSES.has(milestoneStatus)
      && !milestoneAdopted
      && !milestoneHasAdoptedDescendant
      && (milestoneStatusAuthoritative || milestoneInserted)
    ) {
      const summaryPath = resolveMilestoneFile(basePath, milestoneId, 'SUMMARY');
      // #1291: preserve an existing completion timestamp so a re-import backfills
      // only rows that lack one, never re-stamping an already-complete milestone
      // with the current import time. Same guard as the task path below.
      updateMilestoneStatus(milestoneId, milestoneStatus, importCompletionTimestamp(summaryPath), true);
    }
    counts.milestones++;

    // Parse roadmap for slices
    if (!roadmap) continue;

    for (let si = 0; si < roadmap.slices.length; si++) {
      const sliceEntry = roadmap.slices[si]!;
      // Per K002: use 'complete' not 'done'
      const sliceStatus = sliceEntry.done ? 'complete' : 'pending';

      // Parse slice plan early so goal is available for insertSlice planning column
      const planPath = resolveSliceFile(basePath, milestoneId, sliceEntry.id, 'PLAN');
      let plan: ReturnType<typeof parsePlan> | null = null;
      if (planPath && existsSync(planPath)) {
        const planContent = readFileSync(planPath, 'utf-8');
        plan = parsePlan(planContent);
      }

      // #027: for an out-of-scope milestone, echo the existing DB status of a
      // slice that already exists so the upsert's `ELSE excluded.status` branch
      // becomes a no-op instead of flipping a reopened `pending` slice back to
      // `complete` from a stale checkbox. New slices (not yet in the DB) take the
      // parsed status regardless of scope.
      const sliceRowExists = existingSliceStatus.has(sliceEntry.id);
      const sliceAdopted = adoptedKeys.has(`slice:${sliceEntry.id}`);
      const sliceHasAdoptedTask = [...adoptedKeys].some((key) =>
        key.startsWith(`task:${sliceEntry.id}/`));
      const sliceCompletionBlocked = IMPORT_COMPLETE_STATUSES.has(sliceStatus)
        && sliceHasAdoptedTask;
      const sliceStatusAuthoritative = !sliceAdopted
        && !sliceCompletionBlocked
        && (milestoneStatusAuthoritative || !sliceRowExists);
      const effectiveSliceStatus = sliceStatusAuthoritative
        ? sliceStatus
        : existingSliceStatus.get(sliceEntry.id)!;

      insertSlice({
        id: sliceEntry.id,
        milestoneId: milestoneId,
        title: sliceEntry.title,
        status: effectiveSliceStatus,
        risk: sliceEntry.risk,
        depends: (sliceEntry.depends ?? []).map(d => d.replace(/^\[|\]$/g, '')).filter(d => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(d)),
        demo: sliceEntry.demo,
        sequence: si + 1, // Preserve roadmap parse order (#3356)
        isSketch: sliceEntry.isSketch ?? false, // ADR-011: preserve the `[sketch]` flag on re-import
        planning: {
          goal: plan?.goal ?? '',
        },
      });
      // insertSlice never sets completed_at; backfill it for slices imported as
      // complete (same rationale as milestones above). #027: skip when preserving
      // an out-of-scope slice's existing DB status.
      if (IMPORT_COMPLETE_STATUSES.has(sliceStatus) && sliceStatusAuthoritative) {
        const sliceSummary = resolveSliceFile(basePath, milestoneId, sliceEntry.id, 'SUMMARY');
        // #1291: preserve an existing completion timestamp so a re-import backfills
        // only slices that lack one, never re-stamping an already-complete slice
        // with the current import time. Same guard as the task path below.
        updateSliceStatus(
          milestoneId,
          sliceEntry.id,
          sliceStatus,
          importCompletionTimestamp(sliceSummary),
          true,
        );
      }
      counts.slices++;

      // Insert tasks from parsed plan.
      // Sketch slices carry only a stub PLAN until refined; do not seed DB
      // tasks from a placeholder <tasks> block (would falsely flip
      // planning -> executing before the slice is decomposed). Once the
      // `[sketch]` badge is removed by a real plan-slice, tasks import
      // normally on the next pass. (#1286)
      if (!plan || sliceEntry.isSketch) continue;

      for (const taskEntry of plan.tasks) {
        // Per K002: use 'complete' not 'done'
        let taskStatus: string = taskEntry.done ? 'complete' : 'pending';

        // Resolve the per-task SUMMARY.md. Legacy layout keeps summaries under
        // a tasks/ subdir; flat-phase writes TID-SUMMARY.md directly in the
        // phase dir (execute-task's gsd_task_complete writes it there). A tasks/
        // subdir may still exist in flat-phase for auxiliary artifacts — its
        // mere existence must NOT redirect summary resolution into tasks/ (#1208).
        const slicePath = resolveSlicePath(basePath, milestoneId, sliceEntry.id);
        let taskSummaryFile: string | null = null;
        let isLegacySlice = false;
        // Legacy layout keeps per-task summaries under a tasks/ subdir. Its
        // presence — not merely "is this a legacy slice" — is what makes a
        // missing summary a downgrade signal. resolveTasksDir returns null when
        // no such dir exists, so a legacy slice whose checkbox is the only
        // completion signal (no tasks/ dir at all) is left complete on import.
        let legacyTasksDir: string | null = null;
        if (slicePath) {
          isLegacySlice = basename(dirname(slicePath)) === 'slices';
          legacyTasksDir = isLegacySlice
            ? resolveTasksDir(basePath, milestoneId, sliceEntry.id)
            : null;
          taskSummaryFile = resolveTaskFile(basePath, milestoneId, sliceEntry.id, taskEntry.id, 'SUMMARY');
        }
        const hasTaskSummary = taskSummaryFile !== null && existsSync(taskSummaryFile);

        // Pre-migration consistency (legacy tasks/ layout only): if a task is
        // marked done but its tasks/ dir has no per-task SUMMARY.md, import it
        // as pending so it gets re-executed rather than silently entering the DB
        // as complete. A legacy slice with no tasks/ dir (checkbox-only
        // completion) and flat-phase layout are both left as-is here.
        if (taskStatus === 'complete' && legacyTasksDir !== null && !hasTaskSummary) {
          taskStatus = 'pending';
          process.stderr.write(
            `gsd-migrate: ${milestoneId}/${sliceEntry.id}/${taskEntry.id} marked done but missing summary — importing as pending\n`,
          );
        }

        // Lost-update guard (#1222): a per-task SUMMARY.md is the durable
        // completion attestation written by gsd_task_complete. When the plan
        // checkbox is stale-unchecked but the SUMMARY exists on disk, a
        // re-import must NOT downgrade the completed task back to pending — that
        // silent revert is the lost-update that hard-stopped auto-mode after the
        // first execute-task. The surviving SUMMARY wins over a stale checkbox.
        // reopen-task removes the SUMMARY, so this never re-completes an
        // intentionally reopened task.
        // Flat-phase summaries are phase-scoped; when a milestone has multiple
        // slices, require the summary parent frontmatter to match so one slice's
        // completion does not attest a sibling's same-named task.
        let summaryAttestsCompletion = hasTaskSummary;
        if (summaryAttestsCompletion && !isLegacySlice && roadmap.slices.length > 1 && taskSummaryFile) {
          try {
            const summaryContent = readFileSync(taskSummaryFile, 'utf-8');
            summaryAttestsCompletion = parseSummary(summaryContent).frontmatter.parent === sliceEntry.id;
          } catch {
            summaryAttestsCompletion = false;
          }
        }
        if (taskStatus === 'pending' && summaryAttestsCompletion) {
          taskStatus = 'complete';
          process.stderr.write(
            `gsd-migrate: ${milestoneId}/${sliceEntry.id}/${taskEntry.id} unchecked in plan but SUMMARY.md present — importing as complete (#1222)\n`,
          );
        }

        // #027: same scope guard as slices — out-of-scope milestones echo existing
        // DB task status so stale plan checkboxes cannot re-complete reopened tasks.
        const taskRowExists = existingTaskStatus.has(`${sliceEntry.id}/${taskEntry.id}`);
        const taskAdopted = adoptedKeys.has(`task:${sliceEntry.id}/${taskEntry.id}`);
        const taskStatusAuthoritative = !taskAdopted
          && (milestoneStatusAuthoritative || !taskRowExists);
        const effectiveTaskStatus = taskStatusAuthoritative
          ? taskStatus
          : existingTaskStatus.get(`${sliceEntry.id}/${taskEntry.id}`)!;

        insertTask({
          id: taskEntry.id,
          sliceId: sliceEntry.id,
          milestoneId: milestoneId,
          title: taskEntry.title,
          status: effectiveTaskStatus,
          planning: {
            files: taskEntry.files ?? [],
            verify: taskEntry.verify ?? '',
          },
          // #1222 (metadata half): re-import derives status from the plan/summary
          // but has none of the execution prose gsd_task_complete wrote to the DB.
          // Preserve the existing row's execution columns and completed_at so a
          // re-import cannot blank a completed task's summary metadata or refresh
          // its completion timestamp — the DB row is strictly richer than the plan.
          preserveCompletionMetadata: true,
        });
        counts.tasks++;
      }

      // Pre-migration consistency: if all tasks are done and the slice
      // summary exists but the roadmap checkbox is unchecked, upgrade the
      // slice to complete. This handles the common
      // "all_tasks_done_roadmap_not_checked" inconsistency that the old
      // doctor would have auto-fixed. Without a slice summary, the slice
      // is in the "summarizing" phase, not complete.
      if (!sliceEntry.done) {
        const sliceSummaryPath = resolveSliceFile(basePath, milestoneId, sliceEntry.id, 'SUMMARY');
        const hasSliceSummary = sliceSummaryPath !== null && existsSync(sliceSummaryPath);
        const slicePathForTasks = resolveSlicePath(basePath, milestoneId, sliceEntry.id);
        const isLegacySliceLayout = slicePathForTasks !== null
          && basename(dirname(slicePathForTasks)) === 'slices';
        const taskSummaryDir = slicePathForTasks
          ? (isLegacySliceLayout
              ? (resolveTasksDir(basePath, milestoneId, sliceEntry.id) ?? slicePathForTasks)
              : slicePathForTasks)
          : null;
        const allTasksDone = plan.tasks.length > 0 && plan.tasks.every(t => {
          const taskSummaryFile = taskSummaryDir !== null
            ? join(taskSummaryDir, `${t.id}-SUMMARY.md`)
            : null;
          const hasTaskSummary = taskSummaryFile !== null && existsSync(taskSummaryFile);
          let summaryAttestsCompletion = hasTaskSummary;
          if (summaryAttestsCompletion && !isLegacySliceLayout && roadmap.slices.length > 1 && taskSummaryFile) {
            try {
              const summaryContent = readFileSync(taskSummaryFile, 'utf-8');
              summaryAttestsCompletion = parseSummary(summaryContent).frontmatter.parent === sliceEntry.id;
            } catch {
              summaryAttestsCompletion = false;
            }
          }
          // Match per-task import rules above: SUMMARY attestation wins over a stale
          // checkbox (#1222); flat-phase checkboxes are authoritative without summary.
          return summaryAttestsCompletion || (t.done && !isLegacySliceLayout);
        });
        // #027: the same close guard as the backfill above — a stale slice
        // SUMMARY under an out-of-scope milestone must not upgrade a reopened
        // slice to complete. New slices stay authoritative.
        if (allTasksDone && hasSliceSummary && sliceStatusAuthoritative && !sliceHasAdoptedTask) {
          if (_getAdapter()) {
            // #1291: preserve an existing completion timestamp — this consistency
            // upgrade sets a completion time only when the row lacks one.
            updateSliceStatus(
              milestoneId,
              sliceEntry.id,
              'complete',
              importCompletionTimestamp(sliceSummaryPath),
              true,
            );
            process.stderr.write(
              `gsd-migrate: ${milestoneId}/${sliceEntry.id} all tasks + slice summary complete — upgrading slice to complete\n`,
            );
          }
        }
      }
    }
  }

  return counts;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Import all markdown artifacts from a .gsd/ directory into the database.
 * Opens the DB if not already open. Wraps all imports in a single transaction.
 * Returns counts of imported items for logging.
 *
 * Missing files are skipped gracefully — no errors produced.
 *
 * TEST-ONLY: unconsented markdown→DB write path with zero production callers.
 * Production imports must go through the Import Application — see the loud
 * warning at the top of this file.
 */
export function migrateFromMarkdown(gsdDir: string): {
  decisions: number;
  requirements: number;
  artifacts: number;
  hierarchy: { milestones: number; slices: number; tasks: number };
} {
  const dbPath = join(gsdRoot(gsdDir), 'gsd.db');

  // Open DB if not already open
  if (!_getAdapter()) {
    openWorkflowDatabasePath(dbPath);
  }

  let decisions = 0;
  let requirements = 0;
  let artifacts = 0;
  let hierarchy = { milestones: 0, slices: 0, tasks: 0 };

  transaction(() => {
    try {
      decisions = importDecisions(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping decisions import: ${(err as Error).message}`);
    }

    try {
      requirements = importRequirements(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping requirements import: ${(err as Error).message}`);
    }

    try {
      artifacts = importHierarchyArtifacts(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping artifacts import: ${(err as Error).message}`);
    }

    try {
      hierarchy = migrateHierarchyToDb(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping hierarchy migration: ${(err as Error).message}`);
    }
  });

  process.stderr.write(
    `gsd-migrate: imported ${decisions} decisions, ${requirements} requirements, ${artifacts} artifacts, ${hierarchy.milestones}M/${hierarchy.slices}S/${hierarchy.tasks}T hierarchy\n`,
  );

  return { decisions, requirements, artifacts, hierarchy };
}
