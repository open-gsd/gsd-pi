// Project/App: gsd-pi
// File Purpose: Preserve externally changed managed projections before mutation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import { classifyGsdLogicalPath } from "./projection-path-policy.js";
import { computeProjectionSha } from "./projection-content-hash.js";
import { isValidCompatMarker } from "./compat/compat-marker-validation.js";

type ProjectionRoot = ".gsd" | ".planning";

/**
 * Find the projection root that holds the file. `gsdDir` is the state
 * directory: it holds the compat marker and the quarantine. With external
 * state, writers pass the real path under `~/.gsd/projects/<hash>` (the target
 * of the project's `.gsd` symlink). That path has no `.gsd` segment for the
 * project, so the state directory is also recognised by its `gsd.db`.
 */
function projectionLocation(filePath: string): {
  gsdDir: string;
  rootName: ProjectionRoot;
  relPath: string;
} | null {
  const absolutePath = resolve(filePath);
  let current = dirname(absolutePath);
  while (current !== dirname(current)) {
    const name = basename(current).toLocaleLowerCase("en-US");
    const relPath = relative(current, absolutePath).replace(/\\/g, "/");
    if (name === ".planning") {
      return { gsdDir: join(dirname(current), ".gsd"), rootName: ".planning", relPath };
    }
    if (name === ".gsd" || existsSync(join(current, "gsd.db"))) {
      return { gsdDir: current, rootName: ".gsd", relPath };
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
  gsdDir: string,
  rootName: ProjectionRoot,
  relPath: string,
): string | undefined {
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(gsdDir, ".compat.json"), "utf-8"));
  } catch {
    return undefined;
  }
  if (!isValidCompatMarker(marker)) return undefined;
  if (rootName === ".gsd") return marker.projections[relPath]?.sha;
  return marker.planning?.projections[relPath]?.sha;
}

function uniqueQuarantinePath(gsdDir: string, rootName: ProjectionRoot, relPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(gsdDir, "quarantine", "projections", stamp, rootName.slice(1), relPath);
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
    if (location.relPath.toLocaleLowerCase("en-US") === "state.md") return false;
    if (classifyGsdLogicalPath(location.relPath) !== "managed") return false;
  } else if (isPlanningPassthrough(location.relPath)) {
    return false;
  }
  if (!existsSync(filePath)) return false;

  const current = readFileSync(filePath);
  const currentSha = computeProjectionSha(current.toString("utf-8"));
  if (nextContent && currentSha === computeProjectionSha(nextContent.toString("utf-8"))) return false;
  if (currentSha === baselineSha(location.gsdDir, location.rootName, location.relPath)) return false;

  const target = uniqueQuarantinePath(location.gsdDir, location.rootName, location.relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, current);
  return true;
}
