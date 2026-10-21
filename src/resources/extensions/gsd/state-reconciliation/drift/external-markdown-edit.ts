// Project/App: gsd-pi
// File Purpose: Observe external .gsd edits and retain the opt-in legacy drift handler.
//
// gsd-pi's DB is canonical, while .gsd/*.md is a readable projection. External
// modeled edits are reported to the Projection Worker for preservation. Runtime
// reconciliation does not register the legacy blocker handler below.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
  type ProjectionEntry,
} from "../../compat/compat-marker.js";
import { _getAdapter } from "../../gsd-db.js";
import { logWarning } from "../../workflow-logger.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type ExternalMarkdownEditDrift = Extract<
  DriftRecord,
  { kind: "external-markdown-edit" }
>;

type ArtifactContentRow = {
  full_content: string;
};

type ProjectionScope = {
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
};

function deepestProjectionScope(entities: readonly string[]): ProjectionScope | null {
  let best: string[] | null = null;
  for (const entity of entities) {
    const parts = entity.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    if (!best || parts.length > best.length) best = parts;
  }
  if (!best) return null;
  return {
    milestoneId: best[0]!,
    sliceId: best[1] ?? null,
    taskId: best[2] ?? null,
  };
}

function artifactTypeFromProjectionPath(projectionPath: string): string | null {
  const name = basename(projectionPath);
  const match = name.match(/^(?:[A-Za-z]\d+|\d+(?:-\d+)?)-(.+)\.md$/);
  return match?.[1]?.toUpperCase() ?? null;
}

function dbProjectionMatches(
  projectionPath: string,
  entry: ProjectionEntry,
  actualSha: string,
): boolean {
  const adapter = _getAdapter();
  if (!adapter) return false;

  try {
    const rows: ArtifactContentRow[] = adapter
      .prepare("SELECT full_content FROM artifacts WHERE path = :path")
      .all({ ":path": projectionPath }) as ArtifactContentRow[];

    const scope = deepestProjectionScope(entry.entities);
    const artifactType = artifactTypeFromProjectionPath(projectionPath);
    if (scope?.taskId) {
      rows.push(
        ...(adapter
          .prepare(
            `SELECT full_content
             FROM artifacts
             WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid
               AND (:type IS NULL OR artifact_type = :type)`,
          )
          .all({
            ":mid": scope.milestoneId,
            ":sid": scope.sliceId,
            ":tid": scope.taskId,
            ":type": artifactType,
          }) as ArtifactContentRow[]),
      );
    } else if (scope?.sliceId) {
      rows.push(
        ...(adapter
          .prepare(
            `SELECT full_content
             FROM artifacts
             WHERE milestone_id = :mid AND slice_id = :sid AND task_id IS NULL
               AND (:type IS NULL OR artifact_type = :type)`,
          )
          .all({
            ":mid": scope.milestoneId,
            ":sid": scope.sliceId,
            ":type": artifactType,
          }) as ArtifactContentRow[]),
      );
    } else if (scope) {
      rows.push(
        ...(adapter
          .prepare(
            `SELECT full_content
             FROM artifacts
             WHERE milestone_id = :mid AND slice_id IS NULL AND task_id IS NULL
               AND (:type IS NULL OR artifact_type = :type)`,
          )
          .all({ ":mid": scope.milestoneId, ":type": artifactType }) as ArtifactContentRow[]),
      );
    }

    return rows.some((row) => computeProjectionSha(row.full_content) === actualSha);
  } catch {
    return false;
  }
}

/**
 * Detect sha drift between the marker baseline and current file contents.
 *
 * - Missing marker → no records (the broader /gsd recover flow handles a
 *   cold-start; this handler only fires when we have a baseline to compare).
 * - Missing file on disk → no record (other handlers cover missing artifacts).
 * - Sha match → no record (gsd-pi's own write or no change).
 * - Sha mismatch → one record per drifted file, scoped to its recorded entities.
 */
export function observeExternalMarkdownEdits(
  basePath: string,
  dryRun = false,
): ExternalMarkdownEditDrift[] {
  const marker = readCompatMarker(basePath, {
    healInvalidKeys: !dryRun,
    quarantineInvalid: !dryRun,
  });
  const entries = Object.entries(marker.projections);
  if (entries.length === 0) return [];

  const records: ExternalMarkdownEditDrift[] = [];
  let markerChanged = false;
  for (const [projectionPath, entry] of entries) {
    const abs = join(basePath, ".gsd", projectionPath);
    if (!existsSync(abs)) continue;
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    if (actual === entry.sha) continue;
    if (dbProjectionMatches(projectionPath, entry, actual)) {
      if (!dryRun) {
        marker.projections[projectionPath] = {
          sha: actual,
          entities: entry.entities,
        };
        markerChanged = true;
        logWarning(
          "reconcile",
          `external-markdown-edit: refreshed stale compat marker for ${projectionPath} (expectedSha=${entry.sha}, actualSha=${actual})`,
        );
      } else {
        logWarning(
          "reconcile",
          `external-markdown-edit: stale compat marker for ${projectionPath} (expectedSha=${entry.sha}, actualSha=${actual})`,
        );
      }
      continue;
    }
    logWarning(
      "reconcile",
      `external-markdown-edit drift for ${projectionPath} (expectedSha=${entry.sha}, actualSha=${actual})`,
    );
    records.push({
      kind: "external-markdown-edit",
      projectionPath,
      expectedSha: entry.sha,
      actualSha: actual,
      entities: entry.entities,
    });
  }
  if (markerChanged) {
    marker.lastWriter = "gsd-pi";
    marker.lastProjectedAt = new Date().toISOString();
    writeCompatMarker(basePath, marker);
  }
  return records;
}

function externalMarkdownEditBlocker(record: ExternalMarkdownEditDrift): string {
  return [
    `External modeled edit detected in \`.gsd/${record.projectionPath}\`.`,
    "The database is authoritative, so GSD paused before importing or overwriting this projection.",
    "Recommended: run `/gsd rebuild markdown` to restore the database projection.",
    "If this edit should replace database state, review it first, then run `/gsd recover` and approve its exact hash through the explicit Preview/Application flow.",
  ].join(" ");
}

function repairExternalMarkdownEdit(
  record: ExternalMarkdownEditDrift,
  _ctx: DriftContext,
): never {
  throw new Error(
    `Invariant violation: modeled projection repair must remain blocked for .gsd/${record.projectionPath}`,
  );
}

export const externalMarkdownEditHandler: DriftHandler<ExternalMarkdownEditDrift> = {
  kind: "external-markdown-edit",
  detect: (_state: GSDState, ctx: DriftContext) =>
    observeExternalMarkdownEdits(ctx.basePath, ctx.dryRun),
  blocker: externalMarkdownEditBlocker,
  repair: repairExternalMarkdownEdit,
};
