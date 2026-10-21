// Project/App: gsd-pi
// File Purpose: Observe and preserve externally changed projection bytes before canonical rendering.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { atomicWriteBufferSync } from "./atomic-write.js";
import { gsdProjectionRoot, normalizeRealPath } from "./paths.js";
import { isTransientProjectionLockError } from "./projection-root-errors.js";
import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "./compat/compat-marker.js";
import { withProjectionMutation, withProjectionMutationSync } from "./database-maintenance-fence.js";
import { detectProjectionDrift } from "./markdown-renderer.js";
import { observeExternalMarkdownEdits } from "./state-reconciliation/drift/external-markdown-edit.js";
import { observeExternalPlanningEdits } from "./state-reconciliation/drift/external-planning-edit.js";
import type { DriftRecord } from "./state-reconciliation/types.js";

type ExternalProjectionEdit = Extract<
  DriftRecord,
  { kind: "external-markdown-edit" | "external-planning-edit" }
>;

export interface PreservedProjectionEvidence {
  sourcePath: string;
  quarantinePath: string;
  observation?: ExternalProjectionEdit;
}

export interface ProjectionObservationResult {
  preserved: PreservedProjectionEvidence[];
  refreshedPassthrough: string[];
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  let suffix = 2;
  while (existsSync(`${path}.${suffix}`)) suffix += 1;
  return `${path}.${suffix}`;
}

function quarantineRelativePath(basePath: string, absPath: string): string {
  const normalizedPath = normalizeRealPath(absPath);
  for (const rootName of [".gsd", ".planning"] as const) {
    const root = normalizeRealPath(join(basePath, rootName));
    const rel = relative(root, normalizedPath);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return join(rootName.slice(1), rel);
    }
  }
  return join("external", absPath.replace(/^[/\\]+/, ""));
}

function quarantinePath(basePath: string, absPath: string, stamp: string): string {
  return uniquePath(join(
    gsdProjectionRoot(basePath),
    "quarantine",
    "projections",
    stamp,
    quarantineRelativePath(basePath, absPath),
  ));
}

function readProjectionBytes(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Whether a failed rename may fall back to copy+delete (#1762): cross-device
 * links (EXDEV) and Windows transient sharing violations on the source handle.
 */
export function shouldCopyDeleteOnRenameFailure(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EXDEV" || isTransientProjectionLockError(error);
}

function preserveOne(
  basePath: string,
  absPath: string,
  stamp: string,
  observedBytes: Buffer,
): PreservedProjectionEvidence {
  const claimPath = join(gsdProjectionRoot(basePath), "gsd.db");
  return withProjectionMutationSync(claimPath, () => {
    const target = quarantinePath(basePath, absPath, stamp);
    mkdirSync(dirname(target), { recursive: true });
    const currentBytes = readProjectionBytes(absPath);
    if (currentBytes?.equals(observedBytes)) {
      try {
        renameSync(absPath, target);
      } catch (error) {
        // Cross-device links can't rename (EXDEV), and Windows can hold a
        // transient share on the source — fall back to copy+delete instead of
        // failing the journaled replay forever (#1762).
        if (!shouldCopyDeleteOnRenameFailure(error)) throw error;
        atomicWriteBufferSync(target, currentBytes);
        // force: Windows can mark the source read-only while a share is held.
        rmSync(absPath, { force: true });
      }
    } else {
      atomicWriteBufferSync(target, observedBytes);
    }
    return { sourcePath: absPath, quarantinePath: target };
  });
}

/** Move one known-stale managed projection into the standard quarantine. */
export function quarantineProjectionEvidence(
  basePath: string,
  absPath: string,
): PreservedProjectionEvidence | null {
  const observedBytes = readProjectionBytes(absPath);
  if (!observedBytes) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return preserveOne(basePath, absPath, stamp, observedBytes);
}

/**
 * Preserve every modeled projection whose current bytes differ from its
 * writer-owned baseline, plus any caller-supplied legacy drift paths.
 * Passthrough planning files are observed but never moved because GSD does not
 * render them from database authority.
 */
export async function preserveProjectionEvidence(
  basePath: string,
  additionalPaths: readonly string[] = [],
  dryRun = false,
): Promise<ProjectionObservationResult> {
  const observeAndPreserve = async (): Promise<ProjectionObservationResult> => {
    const planningObservations = await observeExternalPlanningEdits(basePath, dryRun);
    const passthrough = planningObservations.filter((record) => record.passthrough);
    if (!dryRun && passthrough.length > 0) {
      const marker = readCompatMarker(basePath);
      for (const record of passthrough) {
        marker.planning!.passthrough[record.projectionPath] = {
          sha: record.actualSha,
          entities: record.entities,
        };
      }
      marker.lastProjectedAt = new Date().toISOString();
      writeCompatMarker(basePath, marker);
    }
    const observations = [
      ...observeExternalMarkdownEdits(basePath, dryRun),
      ...planningObservations.filter((record) => !record.passthrough),
    ];
    const marker = readCompatMarker(basePath);
    const markdownRoot = normalizeRealPath(join(basePath, ".gsd"));
    const unbaselinedPaths = detectProjectionDrift(basePath)
      .map((entry) => entry.path)
      .filter((path) => {
        const rel = relative(markdownRoot, normalizeRealPath(path)).replace(/\\/g, "/");
        return rel !== ".."
          && !rel.startsWith("../")
          && !isAbsolute(rel)
          && marker.projections[rel] === undefined;
      });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const observedByPath = new Map<string, ExternalProjectionEdit>();
    for (const observation of observations) {
      const root = observation.kind === "external-markdown-edit" ? ".gsd" : ".planning";
      observedByPath.set(join(basePath, root, observation.projectionPath), observation);
    }
    const paths = new Set([
      ...additionalPaths,
      ...unbaselinedPaths,
      ...observedByPath.keys(),
    ]);
    const preserved: PreservedProjectionEvidence[] = [];
    for (const absPath of paths) {
      if (dryRun) {
        if (!existsSync(absPath)) continue;
        preserved.push({
          sourcePath: absPath,
          quarantinePath: quarantinePath(basePath, absPath, stamp),
          observation: observedByPath.get(absPath),
        });
        continue;
      }
      const observedBytes = readProjectionBytes(absPath);
      if (!observedBytes) continue;
      const observation = observedByPath.get(absPath);
      if (
        observation
        && computeProjectionSha(observedBytes.toString("utf-8")) !== observation.actualSha
      ) {
        continue;
      }
      const result = preserveOne(basePath, absPath, stamp, observedBytes);
      preserved.push({ ...result, observation });
    }
    return {
      preserved,
      refreshedPassthrough: passthrough.map((record) => record.projectionPath),
    };
  };

  if (dryRun) return observeAndPreserve();
  const claimPath = join(gsdProjectionRoot(basePath), "gsd.db");
  return withProjectionMutation(claimPath, observeAndPreserve);
}
