/**
 * Cross-platform Python interpreter resolver.
 *
 * Provides utilities to detect the available Python interpreter on the current
 * system and to normalize shell commands that reference `python`/`python3` so
 * that they use whichever interpreter is actually installed.
 *
 * On Windows the canonical names differ (`py -3`, `python`, `python3`), so
 * hard-coded `python3` invocations fail with exit 127. This module detects the
 * working interpreter once (cached for the process lifetime) and rewrites
 * commands accordingly.
 *
 * @module python-resolver
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Cached result of `detectPythonExecutable` keyed by cwd + VIRTUAL_ENV. */
const detectCache = new Map<string, string | null>();

export function venvPythonCandidates(venvRoot: string, platform: string = process.platform): string[] {
  return platform === "win32"
    ? [join(venvRoot, "Scripts", "python.exe"), join(venvRoot, "Scripts", "python3.exe")]
    : [join(venvRoot, "bin", "python"), join(venvRoot, "bin", "python3")];
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

/** Project-local or active-env interpreter path, or null when no venv applies. */
export function resolveVenvInterpreter(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const active = env.VIRTUAL_ENV?.trim();
  if (active) {
    const fromEnv = firstExisting(venvPythonCandidates(active, platform));
    if (fromEnv) return fromEnv;
  }
  if (!cwd) return null;
  for (const name of [".venv", "venv"]) {
    const found = firstExisting(venvPythonCandidates(join(cwd, name), platform));
    if (found) return found;
  }
  return null;
}

export function formatPythonInvocation(executable: string): string {
  if (executable === "py -3") return executable;
  return /[\s"]/.test(executable) ? JSON.stringify(executable) : executable;
}

function detectCacheKey(cwd?: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${cwd ?? ""}|${env.VIRTUAL_ENV ?? ""}`;
}

/**
 * Returns the first working Python invocation, or `null` if none is found.
 *
 * Probe order:
 * 1. `$VIRTUAL_ENV` interpreter, when set and present
 * 2. Project-local `.venv` then `venv` (POSIX `bin/`, Windows `Scripts/`)
 * 3. System fallback — Windows: `py -3` → `python` → `python3`;
 *    other platforms: `python3` → `python`
 *
 * The result is cached per cwd + VIRTUAL_ENV for the process lifetime.
 */
export function detectPythonExecutable(cwd?: string): string | null {
  const key = detectCacheKey(cwd);
  const hit = detectCache.get(key);
  if (hit !== undefined) return hit;
  const venv = resolveVenvInterpreter(cwd);
  if (venv) {
    detectCache.set(key, venv);
    return venv;
  }
  const candidates: string[] = process.platform === "win32"
    ? ["py -3", "python", "python3"]
    : ["python3", "python"];
  for (const candidate of candidates) {
    const [bin, ...args] = candidate.split(" ");
    const r = spawnSync(bin, [...args, "--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) {
      detectCache.set(key, candidate);
      return candidate;
    }
  }
  detectCache.set(key, null);
  return null;
}

/**
 * Rewrites a shell command string so that leading `python`/`python3`/`py`
 * tokens at command boundaries are replaced with the interpreter returned by
 * `detectPythonExecutable`.
 *
 * Only tokens at command boundaries (start of string, or after `&&`, `||`,
 * `;`) are rewritten — mid-string occurrences (e.g. file paths containing
 * "python") are left intact.
 *
 * When no Python interpreter is detected, the command is returned unchanged so
 * that the caller receives a meaningful "command not found" error rather than a
 * silent no-op.
 *
 * @param command - The shell command string to normalize.
 * @returns The command with Python interpreter tokens rewritten, or the
 *   original command if no rewrite is needed.
 */
export function normalizePythonCommand(command: string, cwd?: string): string {
  const executable = detectPythonExecutable(cwd);
  if (!executable) return command;
  const invoked = formatPythonInvocation(executable);

  // Split on common shell separators to handle compound commands.
  // We reconstruct the string preserving the original separators.
  return command.replace(
    /(^\s*|(?:&&|\|\||;)\s*)(?:python3?|py(?:\s+-\d+)?)(?=\s|$)/g,
    (_match, pre: string) => `${pre}${invoked}`,
  );
}

/**
 * Plan-time rewrite for venv projects: bare `pytest`/`python`/`python3` at
 * command boundaries become the venv interpreter. Fully-qualified commands
 * and projects without a venv are left unchanged.
 */
export function normalizeVerifyCommandForVenv(command: string, cwd: string): string {
  const venv = resolveVenvInterpreter(cwd);
  if (!venv) return command;
  const invoked = formatPythonInvocation(venv);
  return command
    .replace(
      /(^\s*|(?:&&|\|\||;)\s*)pytest(?=\s|$)/g,
      (_match, pre: string) => `${pre}${invoked} -m pytest`,
    )
    .replace(
      /(^\s*|(?:&&|\|\||;)\s*)(?:python3?|py(?:\s+-\d+)?)(?=\s|$)/g,
      (_match, pre: string) => `${pre}${invoked}`,
    );
}

export function venvBinDirectory(interpreterPath: string): string {
  return dirname(interpreterPath);
}
