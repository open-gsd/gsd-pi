// Project/App: gsd-pi
// File Purpose: Observe external .planning edits and retain the opt-in legacy drift handler.
// Detects sha drift between the compat marker's planning projections/passthrough
// entries and current .planning/ files.
//
// The Projection Worker preserves modeled bytes; passthrough files have no DB
// model, so their checksum may be refreshed without changing source content.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "../../compat/compat-marker.js";
import {
  isPlanningPassthroughRelPath,
  walkPlanningRelPaths,
} from "../../compat/planning-compat.js";
import { logWarning } from "../../workflow-logger.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type ExternalPlanningEditDrift = Extract<
  DriftRecord,
  { kind: "external-planning-edit" }
>;

function detectOne(
  basePath: string,
  entries: Record<string, { sha: string; entities: string[] }>,
  passthrough: boolean,
): ExternalPlanningEditDrift[] {
  const records: ExternalPlanningEditDrift[] = [];
  for (const [projectionPath, entry] of Object.entries(entries)) {
    const abs = join(basePath, ".planning", projectionPath);
    if (!existsSync(abs)) continue; // missing-file drift is covered by other handlers
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    if (actual === entry.sha) continue;
    records.push({
      kind: "external-planning-edit",
      projectionPath,
      expectedSha: entry.sha,
      actualSha: actual,
      entities: entry.entities,
      passthrough,
    });
  }
  return records;
}

function detectUnseededPlanningFiles(
  basePath: string,
  projections: Record<string, { sha: string; entities: string[] }>,
  passthrough: Record<string, { sha: string; entities: string[] }>,
  includePassthrough = true,
): ExternalPlanningEditDrift[] {
  const planningDir = join(basePath, ".planning");
  if (!existsSync(planningDir)) return [];

  const records: ExternalPlanningEditDrift[] = [];
  for (const relPath of walkPlanningRelPaths(planningDir)) {
    const isPassthrough = isPlanningPassthroughRelPath(relPath);
    if (isPassthrough && !includePassthrough) continue;
    const map = isPassthrough ? passthrough : projections;
    if (map[relPath]) continue;
    const abs = join(planningDir, relPath);
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    records.push({
      kind: "external-planning-edit",
      projectionPath: relPath,
      expectedSha: "",
      actualSha: actual,
      entities: [],
      passthrough: isPassthrough,
    });
  }
  return records;
}

export async function observeExternalPlanningEdits(
  basePath: string,
  dryRun = false,
): Promise<ExternalPlanningEditDrift[]> {
  const marker = readCompatMarker(basePath, {
    healInvalidKeys: !dryRun,
    quarantineInvalid: !dryRun,
  });
  if (!marker.planning?.active) {
    // An inactive but recognizable legacy tree requires an explicit migration.
    // Detect only modeled files here: passthrough baselines are refreshed only
    // after compatibility is active, so first contact remains fully read-only.
    const planningDir = join(basePath, ".planning");
    if (!existsSync(planningDir)) return [];
    try {
      const { parsePlanningDirectory } = await import("../../migrate/parser.js");
      const { detectPlanningLayout } = await import("../../migrate/layout-detect.js");
      const parsed = await parsePlanningDirectory(planningDir);
      const layout = detectPlanningLayout(parsed);
      if (!layout) return [];
      return detectUnseededPlanningFiles(basePath, {}, {}, false);
    } catch (e) {
      logWarning(
        "reconcile",
        `planning layout auto-detection failed: ${(e as Error).message}`,
      );
    }
    return [];
  }
  const projections = marker.planning.projections;
  const passthrough = marker.planning.passthrough;
  const hasBaselines =
    Object.keys(projections).length > 0 || Object.keys(passthrough).length > 0;
  return [
    ...detectOne(basePath, projections, false),
    ...detectOne(basePath, passthrough, true),
    // No baseline yet (post-capture, pre-writePlanningDirectory): skip unseeded
    // detection so every on-disk file is not treated as drift in the same pass.
    ...(hasBaselines ? detectUnseededPlanningFiles(basePath, projections, passthrough) : []),
  ];
}

function externalPlanningEditBlocker(record: ExternalPlanningEditDrift): string | null {
  if (record.passthrough) return null;
  return [
    `External modeled edit detected in \`.planning/${record.projectionPath}\`.`,
    "The database is authoritative, so GSD paused before transforming or importing this projection.",
    "Recommended: run `/gsd rebuild markdown` to restore database-backed projections.",
    "If `.planning` should become the source, use `/gsd migrate` to review and confirm its explicit Preview/Application.",
  ].join(" ");
}

function repairExternalPlanningEdit(
  record: ExternalPlanningEditDrift,
  ctx: DriftContext,
): void {
  // Passthrough: never re-import (no DB model). Just refresh the sha.
  if (record.passthrough) {
    const marker = readCompatMarker(ctx.basePath);
    marker.planning!.passthrough[record.projectionPath] = {
      sha: record.actualSha,
      entities: record.entities,
    };
    marker.lastProjectedAt = new Date().toISOString();
    writeCompatMarker(ctx.basePath, marker);
    return;
  }

  throw new Error(
    `Invariant violation: modeled projection repair must remain blocked for .planning/${record.projectionPath}`,
  );
}

export const externalPlanningEditHandler: DriftHandler<ExternalPlanningEditDrift> = {
  kind: "external-planning-edit",
  detect: (_state: GSDState, ctx: DriftContext) =>
    observeExternalPlanningEdits(ctx.basePath, ctx.dryRun),
  blocker: externalPlanningEditBlocker,
  repair: repairExternalPlanningEdit,
};
