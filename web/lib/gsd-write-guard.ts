// Project/App: gsd-pi
// File Purpose: Deny web file mutations that would erase or overwrite GSD database authority.

/** Directories under .gsd/ that hold runtime state, audit records, or rendered projections. */
const PROTECTED_GSD_DIRS = new Set(["runtime", "audit", "journal", "milestones", "phases"]);

/** Root-level .gsd/ files that are rendered from the database or owned by it. */
const PROTECTED_GSD_FILES = new Set([
  ".compat.json",
  "state.md",
  "project.md",
  "decisions.md",
  "requirements.md",
]);

const DB_FILE_RE = /^gsd\.db/;

/**
 * Return why a web write, rename, delete, or create on `requestedPath` is
 * refused, or null when it is allowed.
 *
 * The database is the authority and the projection files are rendered from
 * it, so the web file API must not change either. Names are compared
 * case-insensitively because macOS and Windows volumes ignore case.
 */
export function gsdWriteDenial(root: "gsd" | "project", requestedPath: string): string | null {
  const segments = requestedPath
    .split(/[/\\]+/)
    .filter((segment) => segment !== "" && segment !== ".")
    .map((segment) => segment.toLowerCase());

  if (segments.some((segment) => DB_FILE_RE.test(segment))) {
    return "the GSD database file is managed by GSD and cannot be changed here";
  }

  let gsdRelative: string[];
  if (root === "gsd") {
    gsdRelative = segments;
  } else if (segments.length === 0 || segments[0] === ".gsd") {
    gsdRelative = segments.slice(1);
  } else {
    return null;
  }

  if (gsdRelative.length === 0) {
    return "the directory that holds the GSD database cannot be changed here";
  }
  if (
    PROTECTED_GSD_DIRS.has(gsdRelative[0]!) ||
    (gsdRelative.length === 1 && PROTECTED_GSD_FILES.has(gsdRelative[0]!))
  ) {
    return "this path is GSD runtime state or a file rendered from the GSD database and is read-only here";
  }
  return null;
}
