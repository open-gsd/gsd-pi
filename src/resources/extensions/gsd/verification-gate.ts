// GSD Extension — Verification Gate
// Pure functions for discovering and running verification commands.
// Discovery order (D003): task plan verify → preference → package.json scripts.
// First non-empty source wins.

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { join, basename, delimiter } from "node:path";
import { tmpdir } from "node:os";
import type { AuditWarning, RuntimeError, VerificationCheck, VerificationResult } from "./types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";
import { normalizePythonCommand, resolveVenvInterpreter, venvBinDirectory, formatPythonInvocation } from "./python-resolver.js";
import {
  isWorkflowSurfaceAliasTool,
  isWorkflowToolSurfaceName,
  stripMcpToolPrefix,
} from "./workflow-tool-surface.js";
import {
  detectPackageManager,
  buildScriptCommand,
  normalizeWindowsPackageManagerCommand,
} from "./package-manager.js";

/** Maximum bytes of stdout/stderr to retain per command (10 KB). */
const MAX_OUTPUT_BYTES = 10 * 1024;

/** Truncate a string to maxBytes, appending a marker if truncated. */
function truncate(value: string | null | undefined, maxBytes: number): string {
  if (!value) return "";
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  // Slice conservatively then trim to last full character
  const buf = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return buf.toString("utf-8") + "\n…[truncated]";
}

function readBoundedCommandOutput(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= MAX_OUTPUT_BYTES) return readFileSync(path, "utf-8");

    const marker = Buffer.from("\n…[truncated]\n", "utf-8");
    const retainedBytes = MAX_OUTPUT_BYTES - marker.byteLength;
    const headBytes = Math.floor(retainedBytes / 2);
    const tailBytes = retainedBytes - headBytes;
    const head = Buffer.allocUnsafe(headBytes);
    const tail = Buffer.allocUnsafe(tailBytes);
    readSync(fd, head, 0, headBytes, 0);
    readSync(fd, tail, 0, tailBytes, size - tailBytes);
    return Buffer.concat([head, marker, tail]).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

// ─── Command Discovery ──────────────────────────────────────────────────────

/** Structured evidence staged by `gsd_task_complete` for the current Task. */
export interface TaskVerificationEvidence {
  command: string;
  exitCode: number;
  verdict: string;
  durationMs?: number;
}

export interface DiscoverCommandsOptions {
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Structured task-specific evidence supplied at completion (#1591). */
  taskEvidence?: TaskVerificationEvidence[];
  cwd: string;
}

/** Description separators after which a verdict token carries only details (#2014). */
const VERDICT_SEPARATORS = [":", "—", " – ", " - "];
const PASSING_VERDICT_RE = /^(pass|passed)$/;

/**
 * Lenient verdict matching (#2014): the tool schema documents decorated and
 * descriptive verdicts (e.g. '✅ pass', 'pass: all checks green'). Strip
 * leading non-alphanumeric markers, then evaluate only the token before the
 * first description separator, case-insensitively. pass/passed → true;
 * fail/failed and any unknown token → false (fail-closed).
 */
function verdictQualifies(verdict: string): boolean {
  const stripped = verdict.trim().replace(/^[^a-zA-Z0-9]+/, "");
  let cut = stripped.length;
  for (const separator of VERDICT_SEPARATORS) {
    const index = stripped.indexOf(separator);
    if (index !== -1 && index < cut) cut = index;
  }
  return PASSING_VERDICT_RE.test(stripped.slice(0, cut).trim().toLowerCase());
}

/**
 * Task-specific evidence qualifies when at least one record exists and every
 * record reports a passing outcome (#1591). The executor's staged verdict is
 * authoritative: negated verify idioms (`! grep -q`, `grep -v`,
 * `git diff --exit-code`) succeed on a non-zero exit, so a "pass" verdict
 * qualifies even with a non-zero exitCode. `exitCode === 0` is the fallback
 * for records staged without a verdict (#2213). Verdict matching is lenient
 * (#2014): leading markers (`✅ pass`) and `pass: <details>` descriptions are
 * accepted; unknown tokens fail closed.
 */
export function hasQualifyingTaskEvidence(
  evidence: TaskVerificationEvidence[] | undefined,
): boolean {
  if (!evidence || evidence.length === 0) return false;
  return evidence.every((record) => {
    const verdict = (record.verdict ?? "").trim();
    if (verdict) return verdictQualifies(verdict);
    return record.exitCode === 0;
  });
}

export interface DiscoveredCommands {
  commands: string[];
  source: VerificationResult["discoverySource"];
}

/** Package.json script keys to probe, in order. */
const PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"] as const;
const INTERPRETER_PREFIX_RE = /^(bash|sh|zsh|node|python3?|ts-node|tsx):\s*/;
const ITEM_WRAPPER_RE = /<\/?item>/gi;

/**
 * Discover verification commands using the first-non-empty-wins strategy (D003):
 *   1. Task plan verify field (split on newlines)
 *   2. Explicit preference commands
 *   3. package.json scripts (typecheck, lint, test)
 *   4. Python pytest project markers
 *   5. Dependency-free Node test files
 *   6. None found
 */
export function discoverCommands(options: DiscoverCommandsOptions): DiscoveredCommands {
  const taskPlanVerify = options.taskPlanVerify && options.taskPlanVerify.trim()
    ? options.taskPlanVerify
    : undefined;
  let hasTaskPlanProse = false;
  let hasUnsafeTaskPlanCommand = false;

  // 1. Task plan verify field (commands are untrusted — sanitize)
  if (taskPlanVerify) {
    const commands: string[] = [];
    // LLM planners sometimes wrap each command in `<item>…</item>` tags. The
    // tags are separators, not shell syntax — turn them into newlines so each
    // wrapped command is validated on its own (#1922).
    const candidates = splitUnquotedLines(taskPlanVerify.replace(ITEM_WRAPPER_RE, "\n"));
    for (const candidate of candidates) {
      const normalized = candidate.replace(INTERPRETER_PREFIX_RE, "").trim();
      const validation = validateVerificationCommand(normalized);
      if (validation.ok) {
        commands.push(normalized);
      } else if (isGsdWorkflowToolInvocation(normalized)) {
        // A GSD tool name describes tool-verified evidence, not a runnable
        // shell command — route to the task-plan-prose fallback instead of
        // executing exit-127 noise that false-fails the task (#1628).
        hasTaskPlanProse = true;
      } else if (validation.reason === "does not look like a runnable command") {
        hasTaskPlanProse = true;
      } else if (splitUnquotedStatements(normalized).some(s => !isLikelyCommand(s))) {
        // Rejected for unsafe syntax, but at least one `;`-separated clause reads
        // as prose — treat the whole candidate as a description, not a command.
        hasTaskPlanProse = true;
      } else {
        hasUnsafeTaskPlanCommand = true;
      }
    }
    if (commands.length > 0) {
      return { commands, source: "task-plan" };
    }
    if (hasUnsafeTaskPlanCommand && !hasTaskPlanProse) {
      // The Task named verify commands but none were shell-safe. Do not
      // silently replace the planner's intent with project-wide checks (#1922).
      return { commands: [], source: "task-plan-unsafe" };
    }
  }

  // A prose verification requirement may be satisfied by the structured
  // evidence staged for this Task. Keep this decision next to preference
  // fallback below so unrelated project-wide checks cannot replace it (#1431).
  const taskEvidenceSatisfiesVerify =
    hasTaskPlanProse &&
    !hasUnsafeTaskPlanCommand &&
    hasQualifyingTaskEvidence(options.taskEvidence);

  // 2. Preference commands
  if (options.preferenceCommands && options.preferenceCommands.length > 0) {
    const filtered = options.preferenceCommands
      .map(c => c.trim())
      .filter(Boolean);
    if (filtered.length > 0) {
      if (taskEvidenceSatisfiesVerify) {
        return { commands: [], source: "task-plan-prose" };
      }
      return { commands: filtered, source: "preference" };
    }
  }

  if (taskEvidenceSatisfiesVerify) {
    return { commands: [], source: "task-plan-prose" };
  }

  // 3. package.json scripts
  const pkgPath = join(options.cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const pm = detectPackageManager(options.cwd) ?? "npm";
        const commands: string[] = [];
        for (const key of PACKAGE_SCRIPT_KEYS) {
          if (typeof pkg.scripts[key] === "string") {
            commands.push(buildScriptCommand(pm, key));
          }
        }
        if (commands.length > 0) {
          return { commands, source: "package-json" };
        }
      }
    } catch {
      // Malformed package.json — fall through to "none"
    }
  }

  const pythonCommand = discoverPythonPytestCommand(options.cwd);
  if (pythonCommand) {
    return { commands: [pythonCommand], source: "python-project" };
  }

  const nodeTestCommand = discoverNodeTestFileCommand(options.cwd);
  if (nodeTestCommand) {
    return { commands: [nodeTestCommand], source: "node-test-file" };
  }

  if (hasTaskPlanProse && !hasUnsafeTaskPlanCommand) {
    return { commands: [], source: "task-plan-prose" };
  }

  // 6. Nothing found
  return { commands: [], source: "none" };
}

function discoverNodeTestFileCommand(cwd: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return null;
  }

  const testFile = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^test-[A-Za-z0-9._-]+\.js$|^[A-Za-z0-9._-]+\.test\.js$/.test(name))
    .sort()[0];

  return testFile ? `node ${testFile}` : null;
}

function discoverPythonPytestCommand(cwd: string): string | null {
  const hasPythonTestFiles = hasPythonTests(join(cwd, "tests"));
  const hasPytestConfig = existsSync(join(cwd, "pytest.ini"));
  const pyprojectPath = join(cwd, "pyproject.toml");
  const hasPyproject = existsSync(pyprojectPath);

  if (!hasPythonTestFiles && !hasPytestConfig && !hasPyproject) {
    return null;
  }

  const pytestCommand = resolvedPytestCommand(cwd);
  if (hasPytestConfig || hasPythonTestFiles) {
    return pytestCommand;
  }

  try {
    const pyproject = readFileSync(pyprojectPath, "utf-8");
    if (
      pyproject.includes("[tool.pytest]") ||
      pyproject.includes("[tool.pytest.") ||
      pyproject.includes("[pytest]") ||
      pyproject.includes("[tool:pytest]")
    ) {
      return pytestCommand;
    }
  } catch {
    // Ignore unreadable pyproject.toml and fall through.
  }

  return null;
}

function resolvedPytestCommand(cwd: string): string {
  const venv = resolveVenvInterpreter(cwd);
  return venv ? `${formatPythonInvocation(venv)} -m pytest` : "python3 -m pytest";
}

function hasPythonTests(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && hasPythonTests(path)) {
      return true;
    }
    if (entry.isFile() && /^test_.*\.py$|^.*_test\.py$/.test(entry.name)) {
      return true;
    }
  }

  return false;
}

// ─── Failure Context Formatting ──────────────────────────────────────────────

/** Maximum chars of command output to include per failed check. */
const MAX_FAILURE_OUTPUT_PER_CHECK = 2_000;

/** Maximum total chars for the combined failure context output. */
const MAX_FAILURE_CONTEXT_CHARS = 10_000;

/**
 * Format failed verification checks into a prompt-injectable text block.
 *
 * Each failed check gets a heading with the command name and exit code,
 * followed by a truncated stderr excerpt. Individual stderr is capped to
 * 2 000 chars; total output is capped to 10 000 chars.
 *
 * Returns an empty string when all checks pass or the checks array is empty.
 */
export function formatFailureContext(result: VerificationResult): string {
  const failures = result.checks.filter((c) => c.exitCode !== 0);
  if (failures.length === 0) return "";

  const blocks: string[] = [];

  for (const check of failures) {
    const hasStderr = (check.stderr ?? "").trim().length > 0;
    const outputLabel = hasStderr ? "stderr" : "stdout";
    let output = hasStderr ? check.stderr ?? "" : check.stdout ?? "";
    if (output.length > MAX_FAILURE_OUTPUT_PER_CHECK) {
      output = output.slice(0, MAX_FAILURE_OUTPUT_PER_CHECK) + "\n…[truncated]";
    }

    blocks.push(
      `### ❌ \`${check.command}\` (exit code ${check.exitCode})\n\`\`\`${outputLabel}\n${output}\n\`\`\``,
    );
  }

  let body = blocks.join("\n\n");
  const header = "## Verification Failures\n\n";

  if (header.length + body.length > MAX_FAILURE_CONTEXT_CHARS) {
    body =
      body.slice(0, MAX_FAILURE_CONTEXT_CHARS - header.length) +
      "\n\n…[remaining failures truncated]";
  }

  return header + body;
}

export function formatFailureSignature(result: VerificationResult): string {
  return result.checks
    .filter((check) => check.exitCode !== 0)
    .map((check) => `${check.command.trim()}#${check.exitCode}`)
    .sort()
    .join("\n");
}

// ─── Gate Execution ─────────────────────────────────────────────────────────

/** Characters that indicate shell control syntax when unquoted in a command string. */
const UNQUOTED_SHELL_CONTROL_CHARS = new Set([";", "<", ">"]);
const EXIT_CODE_ECHO_SUFFIX = /^;\s*echo\s+(?:"exit:\$\?"|'exit:\$\?'|exit:\$\?)\s*$/;

function isAllowedExitCodeEchoSuffix(suffix: string): boolean {
  return EXIT_CODE_ECHO_SUFFIX.test(suffix);
}

/** Returns true when command text contains unquoted shell control syntax. */
function hasUnsafeShellSyntax(cmd: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    // Backtick / $( substitute unless inside single quotes. Double quotes do
    // not protect them — that matches POSIX shell semantics (#1724).
    if (!inSingle && ch === "`") return true;
    if (!inSingle && ch === "$" && cmd[i + 1] === "(") return true;
    if (!inSingle && !inDouble && ch === "|" && cmd[i + 1] === "|") {
      return true;
    }
    if (!inSingle && !inDouble && UNQUOTED_SHELL_CONTROL_CHARS.has(ch)) {
      if (ch === ";" && isAllowedExitCodeEchoSuffix(cmd.slice(i))) {
        return hasUnsafeShellSyntax(cmd.slice(0, i).trim());
      }
      return true;
    }
  }

  return false;
}

/**
 * Split a candidate string on unquoted `;` into individual statements.
 * Used to re-classify prose-vs-command for candidates rejected as unsafe.
 */
/** Split verify text on newlines that are not inside quotes (#1798). */
export function splitUnquotedLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === "\n" && !inSingle && !inDouble) {
      if (current.endsWith("\r")) current = current.slice(0, -1);
      lines.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  lines.push(current);
  return lines.map(s => s.trim()).filter(Boolean);
}

function splitUnquotedStatements(cmd: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === ";" && !inSingle && !inDouble) {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  statements.push(current);
  return statements.map(s => s.trim()).filter(Boolean);
}

function splitLeadingShellWords(cmd: string): string[] {
  const words: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (/\s/.test(ch)) {
        if (current) {
          words.push(current);
          current = "";
        }
        continue;
      }

      if ([";", "|", "&", "<", ">"].includes(ch)) {
        break;
      }
    }

    current += ch;
  }

  if (current) {
    words.push(current);
  }

  return words;
}

function isCountFlag(token: string): boolean {
  return (
    token === "--count" ||
    token.startsWith("--count=") ||
    token === "--count-matches" ||
    token.startsWith("--count-matches=") ||
    /^-[A-Za-z]*c[A-Za-z]*$/.test(token)
  );
}

function countSearchWarning(command: string, exitCode: number): string | null {
  if (exitCode !== 1) return null;

  const trimmed = command.trim();
  if (trimmed.startsWith("!")) return null;

  const [tool, ...args] = splitLeadingShellWords(trimmed);
  if (tool !== "grep" && tool !== "rg") return null;
  if (!args.some(isCountFlag)) return null;

  return `verification-gate: warning: '${tool} -c' returns exit 1 when count=0; for absence checks use '! ${tool} -q ...' instead.`;
}

function appendStderrWarning(stderr: string, warning: string | null): string {
  if (!warning) return stderr;
  const trimmed = stderr.trimEnd();
  return trimmed ? `${trimmed}\n${warning}` : warning;
}

/**
 * Known executable first-tokens that are safe to run.
 * Lowercase commands, common build/test tools, and npm/yarn/pnpm invocations.
 */
const KNOWN_COMMAND_PREFIXES = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "bunx", "deno",
  "uv",
  "node", "ts-node", "tsx", "tsc",
  "sh", "bash", "zsh",
  "echo", "cat", "ls", "test", "true", "false", "pwd", "env",
  "make", "cargo", "go", "python", "python3", "pip", "pip3",
  "ruby", "gem", "bundle", "rake",
  "java", "javac", "mvn", "gradle",
  "docker", "docker-compose",
  "git", "gh",
  "eslint", "prettier", "vitest", "jest", "mocha", "pytest", "phpunit",
  "curl", "wget",
  "grep", "find", "diff", "wc", "sort", "head", "tail",
]);

/**
 * English words that never appear as a shell sub-command or operand but are
 * common in descriptive prose. Deliberately excludes:
 *   - words that double as sub-commands (`build`, `test`, `show`, `run`, ...)
 *   - bare prepositions and single letters, which are plausible operands —
 *     `git diff on master` and `cat a b c` must stay commands
 */
const PROSE_MARKER_WORDS = new Set([
  "an", "the", "is", "are", "was", "were", "should", "shows", "showing",
  "returns", "contains", "confirms", "exists", "piped", "authored",
  "that", "which", "whether", "there", "its", "their",
]);

/**
 * Does a known-command-prefixed string read as prose rather than a command?
 * True when there are English function words after the command word —
 * e.g. "git log shows the scaffold commit authored by ...".
 * Flags after the command word do not suppress this check (#1671).
 */
function readsAsProseAfterCommandWord(tokens: string[]): boolean {
  if (tokens.length < 4) return false;
  return tokens
    .slice(1)
    .some(t => PROSE_MARKER_WORDS.has(t.toLowerCase().replace(/[.,;:!?]+$/, "")));
}

/**
 * Heuristic check: does this string look like an executable shell command
 * rather than a prose description?
 *
 * Returns true when the string appears to be a command. Returns false
 * for English prose (e.g. "Document exists, contains all 5 scale names").
 *
 * Heuristics (any true → command-like):
 *   1. First token is a known command prefix
 *   2. First token starts with `.` or `/` (path-like)
 *   3. Any token starts with `-` (flag-like)
 *   4. First token contains no uppercase letters (commands are lowercase)
 *      AND first token does not end with a comma or colon (prose punctuation)
 *
 * Heuristics (any true → prose-like):
 *   1. First token starts with an uppercase letter and the string has 4+ words
 *   2. String contains commas followed by spaces (prose clause structure)
 *   3. First token has no ASCII letters or digits and the string has 4+ words
 */
export function isLikelyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const effectiveFirstToken = firstToken === "!" ? (tokens[1] ?? "") : firstToken;
  const effectiveTokens = firstToken === "!" ? tokens.slice(1) : tokens;
  if (firstToken === "!" && effectiveTokens.length === 0) return false;

  // Known command prefix → command, unless the rest reads as English prose
  if (KNOWN_COMMAND_PREFIXES.has(effectiveFirstToken)) {
    return !readsAsProseAfterCommandWord(effectiveTokens);
  }

  // Path-like first token → command, unless the rest reads as English prose.
  // "./out/report.txt exists and contains the summary" is a description of a
  // file, not an invocation of it.
  if (effectiveFirstToken.startsWith("/") || effectiveFirstToken.startsWith("./") || effectiveFirstToken.startsWith("../")) {
    return !readsAsProseAfterCommandWord(effectiveTokens);
  }

  // Has flag-like tokens → command
  if (effectiveTokens.some(t => t.startsWith("-"))) return true;

  // First token starts with uppercase + 4 or more words → prose
  if (/^[A-Z]/.test(effectiveFirstToken) && effectiveTokens.length >= 4) return false;

  // Contains comma-space patterns (prose clause separators) → prose
  if (/,\s/.test(trimmed) && tokens.length >= 4) return false;

  // First token has uppercase letters and no path separators → prose
  if (/[A-Z]/.test(effectiveFirstToken) && !effectiveFirstToken.includes("/")) return false;

  // Non-ASCII prose with multiple words should not be executed as a command.
  if (!/[A-Za-z0-9]/.test(effectiveFirstToken) && effectiveTokens.length >= 4) return false;

  // Everything above only rejects prose that announces itself with a capital
  // letter or comma. Lowercase prose fell through to "command" and got executed
  // — `greet/hello.txt exists and contains "hello"` ran the .txt file as a
  // program and failed with exit 126 "Permission denied", failing the gate for
  // a task that had in fact succeeded. English function words are the tell.
  return !readsAsProseAfterCommandWord(effectiveTokens);
}

/**
 * A verify line whose first word names a GSD workflow tool (e.g.
 * `gsd_exec_search limit 1 query D023`) can never run in a shell — executing
 * it yields exit 127 "command not found" and false-fails a task whose
 * substance already passed (#1628). Tool names come from the canonical
 * workflow tool surface (including MCP-prefixed and alias forms); the
 * reserved `gsd_*` namespace also covers planner-written near-tool names.
 * The bare `gsd` CLI is deliberately not matched — `gsd status` is a real
 * shell command.
 */
export function isGsdWorkflowToolInvocation(candidate: string): boolean {
  const firstToken = candidate.trim().replace(INTERPRETER_PREFIX_RE, "").split(/\s+/)[0] ?? "";
  if (!firstToken) return false;
  const baseName = stripMcpToolPrefix(firstToken);
  if (isWorkflowToolSurfaceName(baseName) || isWorkflowSurfaceAliasTool(baseName)) return true;
  return /^gsd_[a-z0-9_]+$/i.test(baseName);
}

/**
 * Find the first verify line that names a GSD workflow tool, for plan-time
 * rejection (#1628). Returns null when every line is tool-name-free.
 */
export function findGsdToolInvocationInVerify(verify: string): string | null {
  return verify
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => isGsdWorkflowToolInvocation(line)) ?? null;
}

/**
 * Plan-time guard (#1628): throw when a task verify names a GSD workflow tool,
 * so tool-name verifies never persist and never reach the gate as exit-127
 * noise. Shared by gsd_plan_task and gsd_replan_task.
 */
export function assertVerifyIsShellCheckable(verify: string): void {
  const toolVerifyLine = findGsdToolInvocationInVerify(verify);
  if (toolVerifyLine) {
    throw new Error(
      `verify must be a shell command, not a GSD tool invocation: "${toolVerifyLine}" — ` +
      "use a shell-checkable command, or describe the tool-verified outcome as prose",
    );
  }
}

/**
 * Validate a command string for obvious shell injection patterns.
 * Returns the command unchanged if safe, or null if suspicious.
 */
export function validateVerificationCommand(cmd: string): { ok: true } | { ok: false; reason: string } {
  if (isGsdWorkflowToolInvocation(cmd)) {
    return { ok: false, reason: "names a GSD workflow tool, which cannot run as a shell command" };
  }
  if (hasUnsafeShellSyntax(cmd)) {
    return { ok: false, reason: "contains shell control syntax such as `||` fallbacks, redirects, semicolons, backticks, or command substitution" };
  }
  if (!isLikelyCommand(cmd)) {
    return { ok: false, reason: "does not look like a runnable command" };
  }
  return { ok: true };
}

export interface RunVerificationGateOptions {
  cwd: string;
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Structured task-specific evidence supplied at completion (#1591). */
  taskEvidence?: TaskVerificationEvidence[];
  /** Per-command timeout in ms. Defaults to 120 000 (2 minutes). */
  commandTimeoutMs?: number;
}

export interface VerificationTarget {
  id: string;
  cwd: string;
  preferenceCommands?: string[];
}

function verificationChildEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GSD_PROJECT_ROOT",
    "GSD_MILESTONE_LOCK",
    "GSD_PARALLEL_WORKER",
    "GSD_SLICE_LOCK",
    "GSD_SLICE_WORKER_TOKEN",
  ]) {
    delete env[key];
  }
  const venv = resolveVenvInterpreter(cwd);
  if (venv) {
    const bin = venvBinDirectory(venv);
    env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

// When targets use different discovery methods, return the highest-priority
// source. Precedence: explicit preference > task-plan > package-json >
// python-project. This avoids a misleading "mixed" label while still
// surfacing that at least one authoritative source was active.
function mergeDiscoverySource(
  sources: VerificationResult["discoverySource"][],
): VerificationResult["discoverySource"] {
  if (sources.length === 0) return "none";
  const first = sources[0];
  if (sources.every((source) => source === first)) return first;
  const precedence: VerificationResult["discoverySource"][] = [
    "preference",
    "task-plan",
    "package-json",
    "python-project",
    "node-test-file",
    "task-plan-prose",
    "task-plan-unsafe",
  ];
  for (const source of precedence) {
    if (sources.includes(source)) return source;
  }
  return "none";
}

function isSpawnTimeout(
  result: { signal: NodeJS.Signals | null },
  error: NodeJS.ErrnoException & { killed?: boolean },
): boolean {
  if (error.code === "ETIMEDOUT") return true;
  if (error.killed && (result.signal === "SIGTERM" || result.signal === "SIGKILL")) return true;
  return /etimedout|timed out/i.test(error.message);
}

function isCommandNotFound(error: NodeJS.ErrnoException): boolean {
  if (error.code === "ENOENT") return true;
  return /enoent|not found/i.test(error.message);
}

function isShellCommandNotFound(exitCode: number, stderr: string): boolean {
  return exitCode === 127
    || /command not found/i.test(stderr)
    || /is not recognized as an internal or external command/i.test(stderr);
}

function isShellParseFailure(exitCode: number, stdout: string, stderr: string): boolean {
  if (exitCode !== 1 || stdout.trim() !== "") return false;
  return /unterminated string constant/i.test(stderr)
    || /syntax error: unterminated quoted string/i.test(stderr)
    || /unexpected eof while looking for matching/i.test(stderr)
    || /syntax error near unexpected token/i.test(stderr)
    || /was unexpected at this time/i.test(stderr);
}

/**
 * Run the verification gate: discover commands, execute each via spawnSync,
 * and return a structured result.
 *
 * - All commands run sequentially regardless of individual pass/fail.
 * - `passed` is true when every command exits 0 (or no commands are discovered).
 * - stdout/stderr per command are truncated to 10 KB.
 */
export function runVerificationGate(options: RunVerificationGateOptions): VerificationResult {
  const timestamp = Date.now();

  const { commands, source } = discoverCommands({
    preferenceCommands: options.preferenceCommands,
    taskPlanVerify: options.taskPlanVerify,
    ...(options.taskEvidence ? { taskEvidence: options.taskEvidence } : {}),
    cwd: options.cwd,
  });

  if (commands.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: source,
      timestamp,
    };
  }

  const checks: VerificationCheck[] = [];

  for (const command of commands) {
    const start = Date.now();
    const rewrittenCommand = normalizeWindowsPackageManagerCommand(
      normalizePythonCommand(rewriteCommandWithRtk(command), options.cwd),
    );
    // Pass the command string as an argument to the shell explicitly
    // to avoid Node.js DEP0190 (spawnSync with shell: true and no args).
    const isWindows = process.platform === "win32";
    const shellBin = isWindows ? "cmd" : "sh";
    const shellArgs = isWindows
      ? ["/d", "/s", "/c", rewrittenCommand]
      : [
          "-c",
          "if command -v bash >/dev/null 2>&1; then exec bash -o pipefail -c \"$1\" verification-gate; fi\nexec sh -c \"$1\" verification-gate",
          "verification-gate",
          rewrittenCommand,
        ];
    const outputDir = mkdtempSync(join(tmpdir(), "gsd-verification-"));
    const stdoutPath = join(outputDir, "stdout");
    const stderrPath = join(outputDir, "stderr");
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    let result: ReturnType<typeof spawnSync>;
    let stdout: string;
    let capturedStderr: string;
    try {
      result = spawnSync(shellBin, shellArgs, {
        cwd: options.cwd,
        env: verificationChildEnvironment(options.cwd),
        stdio: ["ignore", stdoutFd, stderrFd],
        timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        windowsVerbatimArguments: isWindows,
      });
      stdout = readBoundedCommandOutput(stdoutPath);
      capturedStderr = readBoundedCommandOutput(stderrPath);
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      rmSync(outputDir, { recursive: true, force: true });
    }
    const durationMs = Date.now() - start;

    let exitCode: number;
    let stderr: string;

    let failureClass: VerificationCheck["failureClass"];
    if (result.error) {
      const spawnError = result.error as NodeJS.ErrnoException & { killed?: boolean };
      if (isSpawnTimeout(result, spawnError)) {
        const limitMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        exitCode = 124;
        failureClass = "timeout";
        stderr = truncate(
          `${capturedStderr}\ntimed out after ${limitMs}ms. Raise verification_timeout_ms if this command is expected to run longer.`.trim(),
          MAX_OUTPUT_BYTES,
        );
      } else if (isCommandNotFound(spawnError)) {
        exitCode = 127;
        failureClass = "command-not-found";
        stderr = truncate(
          capturedStderr + "\n" + spawnError.message,
          MAX_OUTPUT_BYTES,
        );
      } else {
        exitCode = result.status ?? 1;
        stderr = truncate(
          capturedStderr + "\n" + spawnError.message,
          MAX_OUTPUT_BYTES,
        );
      }
    } else {
      // status is null when killed by signal — treat as failure
      exitCode = result.status ?? 1;
      stderr = capturedStderr;
      if (isShellCommandNotFound(exitCode, stderr)) {
        failureClass = "command-not-found";
      }
    }

    if (!failureClass && isShellParseFailure(exitCode, stdout, stderr)) {
      failureClass = "shell-parse";
    }

    const warning = countSearchWarning(command, exitCode);

    checks.push({
      command,
      exitCode,
      stdout,
      stderr: truncate(appendStderrWarning(stderr, warning), MAX_OUTPUT_BYTES),
      durationMs,
      ...(failureClass ? { failureClass } : {}),
    });
  }

  return {
    passed: checks.every(c => c.exitCode === 0),
    checks,
    discoverySource: source,
    timestamp,
  };
}

export function runVerificationGateForTargets(options: {
  targets: VerificationTarget[];
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Structured task-specific evidence supplied at completion (#1591). */
  taskEvidence?: TaskVerificationEvidence[];
  commandTimeoutMs?: number;
}): VerificationResult {
  const timestamp = Date.now();
  if (options.targets.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: "none",
      timestamp,
    };
  }

  const checks: VerificationCheck[] = [];
  const sources: VerificationResult["discoverySource"][] = [];
  let passed = true;

  for (const target of options.targets) {
    const result = runVerificationGate({
      cwd: target.cwd,
      preferenceCommands: options.preferenceCommands ?? target.preferenceCommands,
      taskPlanVerify: options.taskPlanVerify,
      ...(options.taskEvidence ? { taskEvidence: options.taskEvidence } : {}),
      commandTimeoutMs: options.commandTimeoutMs,
    });
    passed = passed && result.passed;
    sources.push(result.discoverySource);
    for (const check of result.checks) {
      checks.push({
        ...check,
        command: target.id === "project" ? check.command : `[${target.id}] ${check.command}`,
      });
    }
  }

  return {
    passed,
    checks,
    discoverySource: mergeDiscoverySource(sources),
    timestamp,
  };
}

// ─── Runtime Error Capture ──────────────────────────────────────────────────

/** Maximum characters of browser console text to retain per entry. */
const MAX_BROWSER_TEXT_CHARS = 500;

/** Fatal signals that indicate a crash regardless of other status fields. */
const FATAL_SIGNALS = new Set(["SIGABRT", "SIGSEGV", "SIGBUS"]);

/**
 * Injectable dependencies for captureRuntimeErrors.
 * When omitted the function uses dynamic import() to access
 * bg-shell's processes Map and browser-tools' getConsoleLogs().
 * Provide overrides in tests to avoid module mocking.
 */
export interface CaptureRuntimeErrorsOptions {
  getProcesses?: () => Map<string, unknown>;
  getConsoleLogs?: () => Array<{ type: string; text: string; timestamp: number; url: string }>;
}

/**
 * Scan bg-shell processes and browser console logs for runtime errors.
 *
 * Severity classification follows D004:
 *   - bg-shell status "crashed" → blocking crash
 *   - bg-shell !alive && exitCode !== 0 && exitCode !== null → blocking crash
 *   - bg-shell signal SIGABRT/SIGSEGV/SIGBUS → blocking crash
 *   - Browser console error with "Unhandled"/"UnhandledRejection" → blocking crash
 *   - Browser console error (general) → non-blocking error
 *   - Browser console warning with deprecation text → non-blocking warning
 *   - bg-shell alive process with recentErrors → non-blocking error
 *
 * Returns RuntimeError[] — empty when both sources are unavailable.
 */
export async function captureRuntimeErrors(
  options?: CaptureRuntimeErrorsOptions,
): Promise<RuntimeError[]> {
  const errors: RuntimeError[] = [];

  // ── bg-shell scan ─────────────────────────────────────────────────────
  try {
    let processes: Map<string, unknown>;
    if (options?.getProcesses) {
      processes = options.getProcesses();
    } else {
      const mod = await import("../bg-shell/process-manager.js");
      processes = mod.processes;
    }

    for (const [id, raw] of processes) {
      const proc = raw as {
        id: string;
        label?: string;
        status?: string;
        alive?: boolean;
        exitCode?: number | null;
        signal?: string | null;
        recentErrors?: string[];
      };

      const name = proc.label || proc.id || id;

      // Check for fatal signal first (applies regardless of alive/status)
      if (proc.signal && FATAL_SIGNALS.has(proc.signal)) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Crashed status
      if (proc.status === "crashed") {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Non-zero exit on dead process
      if (
        !proc.alive &&
        proc.exitCode !== 0 &&
        proc.exitCode !== null &&
        proc.exitCode !== undefined
      ) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Alive process with recent errors — non-blocking
      if (proc.alive && proc.recentErrors && proc.recentErrors.length > 0) {
        const snippet = proc.recentErrors.slice(0, 3).join("; ");
        errors.push({
          source: "bg-shell",
          severity: "error",
          message: `[${name}] recent errors: ${snippet}`,
          blocking: false,
        });
      }
    }
  } catch {
    // bg-shell not available — skip silently
  }

  // ── browser console scan ──────────────────────────────────────────────
  try {
    let logs: Array<{ type: string; text: string; timestamp: number; url: string }>;
    if (options?.getConsoleLogs) {
      logs = options.getConsoleLogs();
    } else {
      const mod = await import("../browser-tools/state.js");
      logs = mod.getConsoleLogs();
    }

    for (const entry of logs) {
      const text =
        entry.text.length > MAX_BROWSER_TEXT_CHARS
          ? entry.text.slice(0, MAX_BROWSER_TEXT_CHARS) + "…[truncated]"
          : entry.text;

      if (entry.type === "error") {
        // Unhandled rejection / unhandled error → blocking crash
        if (/unhandled/i.test(entry.text)) {
          errors.push({
            source: "browser",
            severity: "crash",
            message: text,
            blocking: true,
          });
        } else {
          // General console.error → non-blocking error
          errors.push({
            source: "browser",
            severity: "error",
            message: text,
            blocking: false,
          });
        }
      } else if (entry.type === "warning" && /deprecated/i.test(entry.text)) {
        // Deprecation warning → non-blocking warning
        errors.push({
          source: "browser",
          severity: "warning",
          message: text,
          blocking: false,
        });
      }
      // Non-deprecation warnings are intentionally ignored
    }
  } catch {
    // browser-tools not available — skip silently
  }

  return errors;
}

/** Build a human-readable message for a bg-shell process error. */
function buildBgShellMessage(
  name: string,
  exitCode: number | null | undefined,
  signal: string | null | undefined,
  recentErrors: string[] | undefined,
): string {
  const parts: string[] = [`[${name}]`];
  if (signal) parts.push(`signal=${signal}`);
  if (exitCode !== null && exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  if (recentErrors && recentErrors.length > 0) {
    const snippet = recentErrors.slice(0, 3).join("; ");
    parts.push(`errors: ${snippet}`);
  }
  return parts.join(" ");
}

// ─── Dependency Audit ───────────────────────────────────────────────────────

/** Top-level dependency files that trigger an audit when changed. */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

/**
 * Injectable dependencies for runDependencyAudit (D023 pattern).
 * When omitted the function uses real git/npm via spawnSync.
 * Provide overrides in tests to avoid real git repos and npm registries.
 */
export interface DependencyAuditOptions {
  gitDiff?: (cwd: string) => string[];
  npmAudit?: (cwd: string) => { stdout: string; exitCode: number };
}

/**
 * Default gitDiff: runs `git diff --name-only HEAD` and returns file paths.
 * Returns empty array on any failure (non-git dir, git not found, etc.).
 */
function defaultGitDiff(cwd: string): string[] {
  try {
    const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Default npmAudit: runs `npm audit --audit-level=moderate --json`.
 * Returns { stdout, exitCode }. Non-zero exit is expected when vulnerabilities exist.
 */
function defaultNpmAudit(cwd: string): { stdout: string; exitCode: number } {
  const result = spawnSync("npm", ["audit", "--audit-level=moderate", "--json"], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? "",
    exitCode: result.status ?? 1,
  };
}

/**
 * Detect dependency file changes and run npm audit if changes are found.
 *
 * - Calls gitDiff to get changed files, checks if any are top-level dependency files
 * - If no dependency files changed, returns []
 * - Runs npmAudit and parses JSON output into AuditWarning[]
 * - Never throws — all errors return []
 * - Non-zero npm audit exit code is expected (vulnerabilities found), not an error
 */
export function runDependencyAudit(
  cwd: string,
  options?: DependencyAuditOptions,
): AuditWarning[] {
  try {
    const gitDiff = options?.gitDiff ?? defaultGitDiff;
    const npmAudit = options?.npmAudit ?? defaultNpmAudit;

    // Get changed files and check for top-level dependency file matches
    const changedFiles = gitDiff(cwd);
    const hasDependencyChange = changedFiles.some((filePath) => {
      const name = basename(filePath);
      // Only match top-level files: the path must equal just the filename
      // (no directory separators) to be considered top-level
      return DEPENDENCY_FILES.has(name) && filePath === name;
    });

    if (!hasDependencyChange) return [];

    // Run npm audit
    const auditResult = npmAudit(cwd);

    // Parse JSON output — npm audit exits non-zero when vulnerabilities exist
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(auditResult.stdout);
    } catch {
      return [];
    }

    // Extract vulnerabilities from the parsed output
    const vulnerabilities = parsed.vulnerabilities;
    if (!vulnerabilities || typeof vulnerabilities !== "object") return [];

    const warnings: AuditWarning[] = [];
    for (const [name, raw] of Object.entries(vulnerabilities as Record<string, unknown>)) {
      const vuln = raw as {
        severity?: string;
        fixAvailable?: boolean;
        via?: unknown[];
      };
      if (!vuln || typeof vuln !== "object") continue;

      const severity = vuln.severity;
      if (
        severity !== "low" &&
        severity !== "moderate" &&
        severity !== "high" &&
        severity !== "critical"
      ) {
        continue;
      }

      // Find the first `via` entry that's an object (not a string reference)
      let title = name;
      let url = "";
      if (Array.isArray(vuln.via)) {
        for (const entry of vuln.via) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const obj = entry as { title?: string; url?: string };
            if (obj.title) title = obj.title;
            if (obj.url) url = obj.url;
            break;
          }
        }
      }

      warnings.push({
        name,
        severity: severity as AuditWarning["severity"],
        title,
        url,
        fixAvailable: vuln.fixAvailable === true,
      });
    }

    return warnings;
  } catch {
    return [];
  }
}
