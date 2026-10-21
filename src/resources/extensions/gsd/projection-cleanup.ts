import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";

import {
  computeProjectionSha,
  deriveCompatProjectionKey,
  readCompatMarker,
  writeCompatMarker,
} from "./compat/compat-marker.js";
import { deleteArtifactByPath, getArtifact } from "./gsd-db.js";
import { gsdProjectionRoot, gsdRoot } from "./paths.js";
import { withProjectionMutationSync } from "./database-maintenance-fence.js";
import { recordManagedProjectionFile } from "./managed-projection-history.js";
import { removeProjectionFileSync } from "./atomic-write.js";

export interface OperationFencedProjectionCleanupInput {
  artifactPath: string;
  operationId: string;
  isCurrent: () => boolean;
}

let cleanupInterleaveForTest: (() => void) | null = null;

export function _setProjectionCleanupInterleaveForTest(hook: (() => void) | null): void {
  cleanupInterleaveForTest = hook;
}

function restoreTombstone(tombstonePath: string, artifactPath: string): void {
  try {
    copyFileSync(tombstonePath, artifactPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    unlinkSync(tombstonePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function removeProjectionIfCurrent(input: OperationFencedProjectionCleanupInput): boolean {
  const { artifactPath, operationId, isCurrent } = input;
  return withProjectionMutationSync(artifactPath, () => {
    const tombstonePath = `${artifactPath}.reopen-${operationId}.pending`;
    if (existsSync(tombstonePath)) {
      recordManagedProjectionFile(artifactPath);
      if (!isCurrent()) {
        restoreTombstone(tombstonePath, artifactPath);
        return false;
      }
      unlinkSync(tombstonePath);
    }
    if (!isCurrent()) return false;
    if (!existsSync(artifactPath)) return true;
    if (lstatSync(artifactPath).isDirectory()) {
      throw new Error(`reopen projection cleanup path is a directory: ${artifactPath}`);
    }
    cleanupInterleaveForTest?.();
    recordManagedProjectionFile(artifactPath);
    try {
      renameSync(artifactPath, tombstonePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return isCurrent();
      throw error;
    }
    if (!isCurrent()) {
      restoreTombstone(tombstonePath, artifactPath);
      return false;
    }
    unlinkSync(tombstonePath);
    return true;
  });
}

export function removeOwnedPlanProjection(basePath: string, planPath: string): boolean {
  const projectionKey = deriveCompatProjectionKey(planPath, [gsdProjectionRoot(basePath), gsdRoot(basePath)]);
  const artifact = getArtifact(projectionKey);
  const marker = readCompatMarker(basePath);

  if (existsSync(planPath)) {
    const content = readFileSync(planPath, "utf8");
    const contentSha = computeProjectionSha(content);
    const markerOwnsCurrentContent = marker.projections[projectionKey]?.sha === contentSha;
    const artifactOwnsCurrentContent = artifact?.artifact_type === "PLAN" &&
      computeProjectionSha(artifact.full_content) === contentSha;
    if (!markerOwnsCurrentContent && !artifactOwnsCurrentContent) return false;
    removeProjectionFileSync(planPath);
  } else if (artifact?.artifact_type !== "PLAN") {
    return false;
  }

  if (artifact?.artifact_type === "PLAN") deleteArtifactByPath(projectionKey);
  if (marker.projections[projectionKey]) {
    delete marker.projections[projectionKey];
    writeCompatMarker(basePath, marker);
  }
  return true;
}
