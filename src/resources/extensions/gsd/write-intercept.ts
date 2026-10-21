// GSD Extension — Write Intercept for Agent State File Blocks
// Detects agent attempts to write authoritative state files and returns
// an error directing the agent to use the engine tool API instead.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Patterns matching authoritative .gsd/ state files that agents must NOT write directly.
 *
 * Projection ownership is defined in
 * docs/dev/state-db-cutover-projection-contract.md, section 1.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  // STATE.md is rendered from authoritative DB state.
  // Case-insensitive to prevent bypass on macOS (case-insensitive APFS).
  // (^|[/\\]) matches both absolute paths (/project/.gsd/…) and bare relative
  // paths (.gsd/STATE.md) so a path without a leading separator is also blocked.
  /(^|[/\\])\.gsd[/\\]STATE\.md$/i,
  // Also match resolved symlink paths under ~/.gsd/projects/ (Pitfall #6)
  /(^|[/\\])\.gsd[/\\]projects[/\\][^/\\]+[/\\]STATE\.md$/i,
  // gsd.db and WAL/SHM files — single-writer WAL connection managed by engine (#3625)
  /(^|[/\\])\.gsd[/\\]gsd\.db(-wal|-shm)?$/i,
  /(^|[/\\])\.gsd[/\\]projects[/\\][^/\\]+[/\\]gsd\.db(-wal|-shm)?$/i,
];

/**
 * Bash write patterns for STATE.md, gsd.db, and database sidecars.
 * Guard behavior and parsing limits are documented in
 * docs/dev/state-db-cutover-projection-contract.md, section 1.
 */
const BASH_STATE_PATTERNS: RegExp[] = [
  // Redirect writes: > STATE.md, >> STATE.md, >| STATE.md.
  // (#2200) A bare '|' is not a redirect — piping into a filename writes nothing,
  // and a quoted grep alternation like "gsd.db\|STATE.md" was misread as one.
  />{1,2}\|?\s*\S*STATE\.md/i,
  // tee to STATE.md
  /\btee\b.*STATE\.md/i,
  // cp/mv with STATE.md as the destination — the state file must be the last
  // significant argument, allowing a closing quote and trailing redirections
  // or comments. Redirection operators within the segment are not separators.
  /\b(?:cp|mv)\b(?:[^;&|\r\n]|&(?=>)|(?<=[<>])&(?=[0-9-])|(?<=>)\|)*STATE\.md(?=["']?(?:(?:[ \t]+[0-9]+|[ \t]*)(?:>>|>\||>&|>|<<|<&|<>|<|&>>?)[ \t]*[^\s;&|<>]+)*(?:[ \t]+#[^\r\n]*)?[ \t]*(?:$|[;|\r\n]|&&|&(?![>&])))/i,
  // sed -i editing STATE.md
  /\bsed\b.*-i.*STATE\.md/i,
  // dd output to STATE.md
  /\bdd\b.*of=\S*STATE\.md/i,
  // Redirect writes to gsd.db (see STATE.md note re: '|')
  />{1,2}\|?\s*\S*gsd\.db/i,
  // cp/mv with gsd.db (or its WAL/SHM sidecars) as the destination (#2200);
  // an optional closing quote still counts (cp x ".gsd/gsd.db")
  /\b(?:cp|mv)\b(?:[^;&|\r\n]|&(?=>)|(?<=[<>])&(?=[0-9-])|(?<=>)\|)*gsd\.db(?:-wal|-shm)?(?=["']?(?:(?:[ \t]+[0-9]+|[ \t]*)(?:>>|>\||>&|>|<<|<&|<>|<|&>>?)[ \t]*[^\s;&|<>]+)*(?:[ \t]+#[^\r\n]*)?[ \t]*(?:$|[;|\r\n]|&&|&(?![>&])))/i,
  // dd output to gsd.db
  /\bdd\b.*of=\S*gsd\.db/i,
  // sqlite3 CLI writing gsd.db, unless opened read-only (#2200): -readonly/--readonly
  // anywhere among the leading option flags makes the whole connection read-only.
  // Without the flag the CLI executes arbitrary SQL, so SELECT/.dump/.schema text
  // does not exempt the invocation. The db path must be the first non-option
  // argument (sqlite3 [OPTIONS] FILE [SQL]); the option region is flags-only, so
  // SQL text after the path cannot inject the exemption, and the required db-path
  // token prevents backtracking from skipping over a later -readonly flag.
  /\bsqlite3\s+(?:(?!-{1,2}readonly\b)-{1,2}[^\s]+\s+)*(?!-{1,2}readonly\b)[^\s]*gsd\.db/i,
];

const BASH_SQLITE_LIBRARY_PATTERNS: RegExp[] = [
  // In-process sqlite libs touching gsd.db (#3625), either argument order
  /\b(?:sqlite3|sql\.js|better-sqlite3|node:sqlite)\b.*gsd\.db/i,
  /\bgsd\.db\b.*\b(?:sqlite3|sql\.js|better-sqlite3|node:sqlite)\b/i,
];

/**
 * Tests whether the given file path matches a blocked authoritative .gsd/ state file.
 * Resolves `..` segments via path.resolve() and attempts realpathSync for symlinks.
 */
export function isBlockedStateFile(filePath: string): boolean {
  // Check raw path first
  if (matchesBlockedPattern(filePath)) return true;

  // Resolve ".." segments (works even for non-existing files)
  const resolved = resolve(filePath);
  if (resolved !== filePath && matchesBlockedPattern(resolved)) return true;

  // Also try symlink resolution — file may not exist yet, so wrap in try/catch
  try {
    const realpath = realpathSync(filePath);
    if (realpath !== filePath && realpath !== resolved && matchesBlockedPattern(realpath)) return true;
  } catch {
    // File doesn't exist yet — path matching above is sufficient
  }

  return false;
}

/**
 * Tests whether a bash command appears to write protected state files.
 */
export function isBashWriteToStateFile(command: string): boolean {
  if (BASH_STATE_PATTERNS.some((pattern) => pattern.test(command))) return true;

  const libraryCommand = command.replace(
    /\bsqlite3\s+(?:-{1,2}[^\s;&|]+\s+)*[^\s;&|]*gsd\.db\b/gi,
    "",
  );
  return BASH_SQLITE_LIBRARY_PATTERNS.some((pattern) => pattern.test(libraryCommand));
}

function matchesBlockedPattern(path: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Error message returned when an agent attempts to directly write an authoritative .gsd/ state file.
 * Directs the agent to use engine tool calls instead.
 */
export const BLOCKED_WRITE_ERROR = `Direct writes to .gsd/STATE.md and .gsd/gsd.db are blocked. Use engine tool calls instead:
- To complete a task: call gsd_task_complete(milestone_id, slice_id, task_id, summary)
- To complete a slice: call gsd_slice_complete(milestone_id, slice_id, summary, uat_result)
- To save a decision: call gsd_decision_save(scope, decision, choice, rationale)
- To start a task: call gsd_start_task(milestone_id, slice_id, task_id)
- To record verification: call gsd_record_verification(milestone_id, slice_id, task_id, evidence)
- To report a blocker: call gsd_report_blocker(milestone_id, slice_id, task_id, description)`;
