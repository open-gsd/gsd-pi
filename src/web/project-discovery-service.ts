import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectDetectionKind, ProjectDetectionSignals } from "./bridge-service.ts";
import { detectMonorepo, detectProjectKind } from "./bridge-service.ts";
import { openProjectDatabaseReadOnly } from "./project-db-read.ts";
import { selectActiveMilestone } from "../resources/extensions/gsd/milestone-readiness.ts";
import { parseMilestoneSequence, splitH2Sections } from "../resources/extensions/gsd/schemas/project-sequence.ts";
import { isClosedStatus, isDiscardedMilestoneStatus } from "../resources/extensions/gsd/status-guards.ts";
import { stripIdPrefix } from "../resources/extensions/gsd/strip-id-prefix.ts";

// ─── Project Discovery ─────────────────────────────────────────────────────

export interface ProjectProgressInfo {
  activeMilestone: string | null;
  activeSlice: string | null;
  phase: string | null;
  milestonesCompleted: number;
  milestonesTotal: number;
}

export interface ProjectMetadata {
  name: string;             // directory name
  path: string;             // absolute path
  kind: ProjectDetectionKind;
  signals: ProjectDetectionSignals;
  lastModified: number;     // mtime epoch ms
  progress?: ProjectProgressInfo | null;
}

/** Excluded directory names when scanning a dev root. */
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

/**
 * Read milestone counts and the active milestone from a project's
 * `.gsd/gsd.db`. The picker lists projects that the user did not open, so the
 * read does not change the project (see `openProjectDatabaseReadOnly`).
 *
 * The active milestone comes from `selectActiveMilestone`, the same rule that
 * state derivation applies. Slice and phase need the full state derivation,
 * so they stay `null` here.
 *
 * Returns `null` when the database cannot be read.
 */
function readDatabaseProgress(projectPath: string): ProjectProgressInfo | null {
  let db: DatabaseSync | undefined;
  try {
    const connection = db = openProjectDatabaseReadOnly(projectPath);

    // The picker reads databases of every schema version. A query that names an
    // absent table or column throws, so each read names only what is there.
    const columnsOf = (table: string): Set<string> =>
      new Set(connection.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
    const milestoneColumns = columnsOf("milestones");
    const hasSequence = milestoneColumns.has("sequence");
    const hasDependsOn = milestoneColumns.has("depends_on");
    const hasArtifacts = columnsOf("artifacts").size > 0;

    // Workflow order: queued milestones (sequence > 0) first, then sequence, then id.
    const rows = connection.prepare(
      `SELECT id, title, status${hasDependsOn ? ", depends_on" : ""} FROM milestones ORDER BY ${
        hasSequence ? "CASE WHEN sequence > 0 THEN 0 ELSE 1 END, sequence, " : ""
      }id`,
    ).all();

    const sliceCounts = new Map<string, number>();
    if (columnsOf("slices").size > 0) {
      for (const row of connection.prepare("SELECT milestone_id, COUNT(*) AS count FROM slices GROUP BY milestone_id").all()) {
        sliceCounts.set(String(row.milestone_id), Number(row.count));
      }
    }
    const contextIds = new Set<string>();
    const draftContextIds = new Set<string>();
    let projectSequenceIds = new Set<string>();
    if (hasArtifacts) {
      for (const row of connection.prepare(
        "SELECT milestone_id, artifact_type FROM artifacts WHERE milestone_id IS NOT NULL AND slice_id IS NULL AND task_id IS NULL AND artifact_type IN ('CONTEXT', 'CONTEXT-DRAFT')",
      ).all()) {
        (row.artifact_type === "CONTEXT" ? contextIds : draftContextIds).add(String(row.milestone_id));
      }
      const project = connection.prepare("SELECT full_content FROM artifacts WHERE path = 'PROJECT.md'").get();
      const { sections } = splitH2Sections(String(project?.full_content ?? ""));
      projectSequenceIds = new Set(parseMilestoneSequence(sections).map((m) => m.id));
    }

    // A discarded milestone is a tombstone: it is not counted and not listed.
    const milestones = rows
      .filter((row) => !isDiscardedMilestoneStatus(String(row.status)))
      .map((row) => {
        const id = String(row.id);
        const status = String(row.status);
        return {
          id,
          title: stripIdPrefix(String(row.title ?? ""), id),
          status,
          dependsOn: JSON.parse(String(row.depends_on ?? "") || "[]") as string[],
          done: isClosedStatus(status),
          parked: status === "parked",
          sliceCount: sliceCounts.get(id) ?? 0,
          hasContext: contextIds.has(id),
          hasDraftContext: draftContextIds.has(id),
        };
      });

    const active = selectActiveMilestone(milestones, projectSequenceIds)?.milestone;
    return {
      activeMilestone: active ? (active.title ? `${active.id}: ${active.title}` : active.id) : null,
      activeSlice: null,
      phase: null,
      milestonesCompleted: milestones.filter((m) => m.done).length,
      milestonesTotal: milestones.length,
    };
  } catch {
    // No database, no SQLite provider, or no milestones table (before schema V5).
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Project progress for the picker. The database is the authority; the
 * `.gsd/STATE.md` projection is read only when the database cannot be read.
 */
function readProjectProgress(projectPath: string): ProjectProgressInfo | null {
  return readDatabaseProgress(projectPath) ?? readStateFileProgress(projectPath);
}

/**
 * Parse a project's `.gsd/STATE.md` for active milestone, slice, phase,
 * and milestone completion tally.
 *
 * Returns `null` when the file is missing or unreadable.
 * Individual fields return `null` when the corresponding line isn't found.
 */
function readStateFileProgress(projectPath: string): ProjectProgressInfo | null {
  try {
    const content = readFileSync(join(projectPath, ".gsd", "STATE.md"), "utf-8");
    const lines = content.split("\n");

    let activeMilestone: string | null = null;
    let activeSlice: string | null = null;
    let phase: string | null = null;
    let milestonesCompleted = 0;
    let milestonesTotal = 0;

    // The renderer writes "None" for an empty active milestone or slice.
    const field = (line: string, label: string): string | null => {
      const value = line.replace(label, "").trim();
      return value && value !== "None" ? value : null;
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("**Active Milestone:**")) {
        activeMilestone = field(trimmed, "**Active Milestone:**");
      } else if (trimmed.startsWith("**Active Slice:**")) {
        activeSlice = field(trimmed, "**Active Slice:**");
      } else if (trimmed.startsWith("**Phase:**")) {
        phase = trimmed.replace("**Phase:**", "").trim() || null;
      } else if (trimmed.startsWith("- ✅")) {
        milestonesCompleted++;
        milestonesTotal++;
      } else if (/^- (🔄|⬜|⏸)/u.test(trimmed)) {
        // Active, pending and parked milestones all count toward the total.
        milestonesTotal++;
      }
    }

    return { activeMilestone, activeSlice, phase, milestonesCompleted, milestonesTotal };
  } catch {
    // File missing or unreadable — no progress available
    return null;
  }
}

/** Inspect one selected checkout without treating its children as projects.
 * Used by host-managed catalogs, whose identity is authoritative even for
 * ordinary repositories, blank workspaces, and Git worktrees (.git files).
 */
export function inspectProject(projectPath: string, includeProgress?: boolean): ProjectMetadata | null {
  try {
    const stat = statSync(projectPath);
    if (!stat.isDirectory()) return null;
    const { kind, signals } = detectProjectKind(projectPath);
    return {
      name: basename(projectPath), path: projectPath, kind, signals,
      lastModified: stat.mtimeMs,
      ...(includeProgress ? { progress: readProjectProgress(projectPath) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Scan one directory level under `devRootPath` and return metadata for each
 * discovered project directory. Hidden dirs (starting with `.`), `node_modules`,
 * and `.git` are excluded.
 *
 * **Monorepo detection:** If `devRootPath` itself looks like a project root
 * (has `.git`, `package.json`, monorepo markers like `pnpm-workspace.yaml` /
 * `lerna.json` / `workspaces` in `package.json`), it is returned as a single
 * project entry instead of scanning its children. This prevents monorepo
 * subdirectories from being listed as independent projects.
 *
 * Returns an empty array if `devRootPath` doesn't exist or isn't readable.
 * Results are sorted alphabetically by name.
 */
export function discoverProjects(devRootPath: string, includeProgress?: boolean): ProjectMetadata[] {
  try {
    // ── Check if the root itself is a project/monorepo ──────────────
    // If the devRoot has a .git repo AND looks like a monorepo (pnpm-workspace,
    // lerna, workspaces, etc.) or looks like a standalone project root (has
    // .gsd, or is a recognizable project), return it as a single entry.
    const rootDetection = detectProjectKind(devRootPath);
    if (rootDetection.signals.isMonorepo) {
      const stat = statSync(devRootPath);
      return [{
        name: basename(devRootPath),
        path: devRootPath,
        kind: rootDetection.kind,
        signals: rootDetection.signals,
        lastModified: stat.mtimeMs,
        ...(includeProgress ? { progress: readProjectProgress(devRootPath) } : {}),
      }];
    }

    // ── Standard multi-project scan ─────────────────────────────────
    const entries = readdirSync(devRootPath, { withFileTypes: true });
    const projects: ProjectMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (EXCLUDED_DIRS.has(entry.name)) continue;

      const fullPath = join(devRootPath, entry.name);
      const { kind, signals } = detectProjectKind(fullPath);
      const stat = statSync(fullPath);

      projects.push({
        name: entry.name,
        path: fullPath,
        kind,
        signals,
        lastModified: stat.mtimeMs,
        ...(includeProgress ? { progress: readProjectProgress(fullPath) } : {}),
      });
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  } catch {
    // devRootPath doesn't exist or isn't readable
    return [];
  }
}
