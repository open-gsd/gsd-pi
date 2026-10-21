// Project/App: gsd-pi
// File Purpose: Preserve externally changed managed projections before mutation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { classifyGsdLogicalPath } from "./projection-path-policy.js";
import { computeProjectionSha } from "./projection-content-hash.js";
import { isValidCompatMarker } from "./compat/compat-marker-validation.js";

type ProjectionRoot = ".gsd" | ".planning";

function projectionLocation(filePath: string): {
  basePath: string;
  rootName: ProjectionRoot;
  relPath: string;
} | null {
  const absolutePath = resolve(filePath);
  let current = dirname(absolutePath);
  while (current !== dirname(current)) {
    const name = basename(current).toLocaleLowerCase("en-US");
    if (name === ".gsd" || name === ".planning") {
      const rootName = name as ProjectionRoot;
      return {
        basePath: dirname(current),
        rootName,
        relPath: relative(current, absolutePath).replace(/\\/g, "/"),
      };
    }
    current = dirname(current);
  }
  return null;
}

function isPlanningPassthrough(relPath: string): boolean {
  if (relPath.startsWith("codebase/") || relPath.startsWith("research/")) return true;
  const name = relPath.split("/").pop() ?? relPath;
  return relPath === "config.json"
    || name === "PATTERNS.md"
    || name === "REVIEWS.md"
    || name.endsWith("-DISCUSSION-LOG.md")
    || (name.endsWith("-RESEARCH.md") && !name.endsWith("-PLAN.md"));
}

function baselineSha(
  basePath: string,
  rootName: ProjectionRoot,
  relPath: string,
): string | undefined {
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(basePath, ".gsd", ".compat.json"), "utf-8"));
  } catch {
    return undefined;
  }
  if (!isValidCompatMarker(marker)) return undefined;
  if (rootName === ".gsd") return marker.projections[relPath]?.sha;
  return marker.planning?.projections[relPath]?.sha;
}

function uniqueQuarantinePath(basePath: string, rootName: ProjectionRoot, relPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(basePath, ".gsd", "quarantine", "projections", stamp, rootName.slice(1), relPath);
  if (!existsSync(path)) return path;
  let suffix = 2;
  while (existsSync(`${path}.${suffix}`)) suffix += 1;
  return `${path}.${suffix}`;
}

/**
 * Copy the observed bytes of an externally edited managed projection into
 * quarantine before its caller mutates it, returning whether evidence was kept.
 *
 * The source file stays in place: the caller's own managed mutation (atomic
 * write or journalled removal) owns the on-disk transition, so a mutation that
 * fails after this point leaves the projection readable instead of leaving the
 * quarantine copy as its only surviving form.
 */
export function preserveManagedProjectionBeforeMutation(
  filePath: string,
  nextContent: Buffer | null,
): boolean {
  const location = projectionLocation(filePath);
  if (!location || extname(location.relPath).toLocaleLowerCase("en-US") !== ".md") return false;
  if (location.rootName === ".gsd") {
    if (classifyGsdLogicalPath(location.relPath) !== "managed") return false;
  } else if (isPlanningPassthrough(location.relPath)) {
    return false;
  }
  if (!existsSync(filePath)) return false;

  const current = readFileSync(filePath);
  const currentSha = computeProjectionSha(current.toString("utf-8"));
  if (nextContent && currentSha === computeProjectionSha(nextContent.toString("utf-8"))) return false;
  if (currentSha === baselineSha(location.basePath, location.rootName, location.relPath)) return false;

  const target = uniqueQuarantinePath(location.basePath, location.rootName, location.relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, current);
  return true;
}
