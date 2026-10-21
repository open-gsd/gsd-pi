// Project/App: gsd-pi
// File Purpose: Deep module owning projection observation, preservation, rendering, and durable delivery.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { readCompatMarker } from "./compat/compat-marker.js";
import { refreshWorkflowDatabaseFromDisk } from "./db-workspace.js";
import {
  captureCurrentProjectionWork,
  settleProjectionWork,
} from "./db/writers/projection-work-delivery.js";
import { deleteArtifactByPath } from "./gsd-db.js";
import { renderAllFromDb } from "./markdown-renderer.js";
import { gsdProjectionRoot, gsdRoot } from "./paths.js";
import {
  preserveProjectionEvidence,
  type ProjectionObservationResult,
} from "./projection-observation.js";
import { deriveState, invalidateStateCache } from "./state.js";
import { detectArtifactDbDrift } from "./state-reconciliation/drift/artifact-db.js";

export interface RebuildMarkdownProjectionsResult {
  rendered: number;
  skipped: number;
  errors: string[];
  quarantined: number;
  quarantinedPaths: string[];
  refreshedPassthrough: string[];
  delivered: number;
}

function resolveDiskArtifactPath(basePath: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) return artifactPath;
  const candidates = [
    join(gsdProjectionRoot(basePath), artifactPath),
    join(gsdRoot(basePath), artifactPath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function artifactPathForDb(basePath: string, absPath: string): string {
  const projectionRoot = gsdProjectionRoot(basePath);
  const projectionRelative = relative(projectionRoot, absPath);
  const withinProjectionRoot = projectionRelative !== ".."
    && !projectionRelative.startsWith(`..${sep}`)
    && !isAbsolute(projectionRelative);
  const artifactPath = withinProjectionRoot
    ? projectionRelative
    : relative(gsdRoot(basePath), absPath);
  return artifactPath.replace(/\\/g, "/");
}

function projectionTreeHash(basePath: string): string {
  const marker = readCompatMarker(basePath);
  const entries = [
    ...Object.entries(marker.projections).map(([path, entry]) => [`.gsd/${path}`, entry.sha]),
    ...Object.entries(marker.planning?.projections ?? {}).map(([path, entry]) => [`.planning/${path}`, entry.sha]),
  ].sort(([left], [right]) => left!.localeCompare(right!));
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

/** Preserve changed projection bytes without participating in workflow progression. */
export function preserveProjectionChanges(
  basePath: string,
  dryRun = false,
): Promise<ProjectionObservationResult> {
  return preserveProjectionEvidence(basePath, [], dryRun);
}

/** Rebuild all readable projections from database authority and settle their durable work. */
export async function rebuildMarkdownProjectionsFromDb(
  basePath: string,
): Promise<RebuildMarkdownProjectionsResult> {
  invalidateStateCache();
  refreshWorkflowDatabaseFromDisk();

  const state = await deriveState(basePath);
  const legacyDriftPaths = detectArtifactDbDrift(state, { basePath, state })
    .flatMap((drift) => drift.kind === "artifact-db-status-divergence"
      && drift.artifactType === "SUMMARY"
      && drift.artifactPath
      ? [resolveDiskArtifactPath(basePath, drift.artifactPath)]
      : []);
  const observation = await preserveProjectionEvidence(basePath, legacyDriftPaths);
  const preserved = observation.preserved;
  const legacyPathSet = new Set(legacyDriftPaths);
  for (const evidence of preserved) {
    if (legacyPathSet.has(evidence.sourcePath)) {
      deleteArtifactByPath(artifactPathForDb(basePath, evidence.sourcePath));
    }
  }

  const deliveryBatch = captureCurrentProjectionWork();
  const rendered = await renderAllFromDb(basePath);
  const delivered = rendered.errors.length === 0
    ? settleProjectionWork(deliveryBatch, { outcome: "rendered", contentHash: projectionTreeHash(basePath) })
    : settleProjectionWork(deliveryBatch, { outcome: "failed", error: rendered.errors.join("\n") });
  invalidateStateCache();

  return {
    ...rendered,
    quarantined: preserved.length,
    quarantinedPaths: preserved.map((evidence) => evidence.quarantinePath),
    refreshedPassthrough: observation.refreshedPassthrough,
    delivered,
  };
}
