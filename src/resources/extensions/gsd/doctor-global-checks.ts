import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { DoctorIssue, DoctorIssueCode } from "./doctor-types.js";
import { readRepoMeta, externalProjectsRoot } from "./repo-identity.js";
import { inspectSqliteReadOnlySnapshot } from "./sqlite-readonly.js";

/**
 * True when a project state directory holds a workflow database with content.
 *
 * repo-meta.json only records where the repo was when GSD last ran in it. A
 * moved or re-cloned repo still maps to this directory, so a stale gitRoot is
 * not proof that the database is dead. Orphan cleanup never deletes such a
 * directory. A database that cannot be read counts as content (fail closed).
 */
export function projectStateHoldsWorkflowData(dirPath: string): boolean {
  const dbPath = join(dirPath, "gsd.db");
  if (!existsSync(dbPath)) return false;
  try {
    return inspectSqliteReadOnlySnapshot(dbPath, (db) =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM milestones").get()?.["n"] ?? 1) > 0);
  } catch {
    return true;
  }
}

/**
 * Check for orphaned project state directories in ~/.gsd/projects/.
 *
 * A project directory is orphaned when its recorded gitRoot no longer exists
 * on disk — the repo was deleted, moved, or the external drive was unmounted.
 * These directories accumulate silently and waste disk space.
 *
 * Severity: info — orphaned state is harmless but takes disk space.
 * Fixable: yes — rmSync the directory, unless it holds a workflow database
 * with content. Never auto-fixed at fixLevel="task".
 */
export async function checkGlobalHealth(
  issues: DoctorIssue[],
  fixesApplied: string[],
  shouldFix: (code: DoctorIssueCode) => boolean,
): Promise<void> {
  try {
    const projectsDir = externalProjectsRoot();

    if (!existsSync(projectsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return; // Can't read directory — skip
    }

    if (entries.length === 0) return;

    const orphaned: Array<{ hash: string; gitRoot: string; remoteUrl: string }> = [];
    let unknownCount = 0;

    for (const hash of entries) {
      const dirPath = join(projectsDir, hash);
      const meta = readRepoMeta(dirPath);
      if (!meta) {
        unknownCount++;
        continue;
      }
      if (!existsSync(meta.gitRoot)) {
        orphaned.push({ hash, gitRoot: meta.gitRoot, remoteUrl: meta.remoteUrl });
      }
    }

    if (orphaned.length === 0) return;

    const labels = orphaned.slice(0, 3).map(o => o.gitRoot).join(", ");
    const overflow = orphaned.length > 3 ? ` (+${orphaned.length - 3} more)` : "";
    const unknownNote = unknownCount > 0 ? ` — ${unknownCount} additional director${unknownCount === 1 ? "y" : "ies"} have no metadata yet (open those repos once to register them)` : "";

    issues.push({
      severity: "info",
      code: "orphaned_project_state",
      scope: "project",
      unitId: "global",
      message: `${orphaned.length} orphaned GSD project state director${orphaned.length === 1 ? "y" : "ies"} in ${projectsDir} whose git root no longer exists: ${labels}${overflow}${unknownNote}. Run /gsd cleanup projects to audit or /gsd cleanup projects --fix to reclaim disk space.`,
      file: projectsDir,
      fixable: true,
    });

    if (shouldFix("orphaned_project_state")) {
      let removed = 0;
      let kept = 0;
      for (const { hash } of orphaned) {
        const dirPath = join(projectsDir, hash);
        if (projectStateHoldsWorkflowData(dirPath)) {
          kept++;
          continue;
        }
        try {
          rmSync(dirPath, { recursive: true, force: true });
          removed++;
        } catch {
          // Individual removal failure is non-fatal — continue with remaining
        }
      }
      const keptNote = kept > 0 ? `; kept ${kept} that hold${kept === 1 ? "s" : ""} a workflow database with content` : "";
      fixesApplied.push(`removed ${removed} orphaned project state director${removed === 1 ? "y" : "ies"} from ${projectsDir}${keptNote}`);
    }
  } catch {
    // Non-fatal — global health check must not block per-project doctor
  }
}
