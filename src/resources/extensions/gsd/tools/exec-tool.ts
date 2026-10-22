// Project/App: gsd-pi
// File Purpose: Executor for the gsd_exec MCP tool.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync } from "node:fs";

import {
  EXEC_DEFAULTS,
  runExecSandbox,
  type ExecSandboxOptions,
  type ExecSandboxRequest,
  type ExecSandboxResult,
} from "../exec-sandbox.js";
import {
  isContextModeEnabled,
  type GSDPreferences,
} from "../preferences-types.js";
import { bashReferencesProjectRootOutsideWorktree } from "../worktree-shell-guard.js";
import { openExistingWorkflowDatabase } from "../db-workspace.js";
import { currentCallerTaskRef, recordExecRun } from "../db/writers/exec-runs.js";
import { getTask } from "../db/queries.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { redactSecrets } from "../redact-secrets.js";
import { readSourceRevisionForRecord } from "../verification-source-integrity.js";
import {
  execRunContractStorage,
  execRunOutputHash,
  runnableTaskPlanCommands,
  verificationCommandInvocation,
  type VerificationCommandInvocation,
} from "../verification-gate.js";
import { contextModeDisabledResult, type ToolExecutionResult } from "./context-mode-tool-result.js";

export interface ExecToolParams {
  runtime?: unknown;
  script?: unknown;
  command?: unknown;
  cmd?: unknown;
  code?: unknown;
  purpose?: string;
  metadata?: Record<string, unknown>;
  timeout_ms?: number;
}

export interface ExecToolDeps {
  baseDir: string;
  preferences: ExecToolPreferences | null;
  /** Optional override for testing. */
  run?: (req: ExecSandboxRequest, opts: ExecSandboxOptions) => Promise<ExecSandboxResult>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  generateId?: () => string;
  signal?: AbortSignal;
  /**
   * Test seam for the Task a verification-form run would bind to (#2982).
   * Default reads the caller's open Task Attempt from the workflow database.
   */
  readVerificationTaskRef?: (baseDir: string) => VerificationExecTaskRef | null;
  /**
   * Capability for the in-process gsd_exec registration only (#2982): Verify
   * commands may run under the verification gate's own invocation when the
   * opt-in preference is set. The workflow MCP server never passes this, so
   * its calls keep the sandboxed allowlist and nothing changes over MCP.
   */
  verificationRunContract?: boolean;
}

type ExecToolPreferences = Pick<
  GSDPreferences,
  "context_mode" | "verification_timeout_ms" | "verification_reuse_exec_evidence"
>;

const UNRELATED_EXEC_DEFAULT_TIMEOUT_MS = 30_000;

export type UatExecIntent =
  | "uat-artifact-check"
  | "uat-runtime-check"
  | "uat-browser-check"
  | "uat-service-start"
  | "uat-log-inspection";

export interface UatExecToolParams extends ExecToolParams {
  milestoneId?: unknown;
  sliceId?: unknown;
  checkId?: unknown;
  intent?: unknown;
  expected?: unknown;
}

const UAT_EXEC_INTENTS: readonly UatExecIntent[] = [
  "uat-artifact-check",
  "uat-runtime-check",
  "uat-browser-check",
  "uat-service-start",
  "uat-log-inspection",
] as const;

const UAT_EXEC_INTENT_ALIASES: Record<string, UatExecIntent> = {
  artifact: "uat-artifact-check",
  "artifact-driven": "uat-artifact-check",
  runtime: "uat-runtime-check",
  "runtime-executable": "uat-runtime-check",
  "live-runtime": "uat-runtime-check",
  browser: "uat-browser-check",
  "browser-executable": "uat-browser-check",
  service: "uat-service-start",
  "service-start": "uat-service-start",
  log: "uat-log-inspection",
  logs: "uat-log-inspection",
  "log-inspection": "uat-log-inspection",
};

export function buildExecOptions(
  baseDir: string,
  preferences: ExecToolPreferences | null | undefined,
  extras?: Pick<ExecSandboxOptions, "env" | "now" | "generateId" | "signal">,
  inheritVerificationTimeout = true,
): ExecSandboxOptions {
  const cfg = preferences?.context_mode;
  const allowlist = Array.isArray(cfg?.exec_env_allowlist) ? cfg!.exec_env_allowlist! : EXEC_DEFAULTS.envAllowlist;
  const stdoutCap = clampNumber(
    cfg?.exec_stdout_cap_bytes,
    EXEC_DEFAULTS.stdoutCapBytes,
    4_096,
    16_777_216,
  );
  const verificationTimeout = clampNumber(
    preferences?.verification_timeout_ms,
    EXEC_DEFAULTS.defaultTimeoutMs,
    1_000,
    EXEC_DEFAULTS.clampTimeoutMs,
  );
  const defaultTimeout = clampNumber(
    cfg?.exec_timeout_ms,
    inheritVerificationTimeout ? verificationTimeout : UNRELATED_EXEC_DEFAULT_TIMEOUT_MS,
    1_000,
    EXEC_DEFAULTS.clampTimeoutMs,
  );
  const digestChars = clampNumber(cfg?.exec_digest_chars, EXEC_DEFAULTS.digestChars, 0, 4_000);
  return {
    baseDir,
    clamp_timeout_ms: EXEC_DEFAULTS.clampTimeoutMs,
    default_timeout_ms: defaultTimeout,
    stdout_cap_bytes: stdoutCap,
    stderr_cap_bytes: EXEC_DEFAULTS.stderrCapBytes,
    digest_chars: digestChars,
    env_allowlist: allowlist,
    ...extras,
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

/**
 * Sandbox timeout options for a prospective exec call, classified the same way
 * executeGsdExec classifies the workload (verification-oriented calls inherit
 * verification_timeout_ms; unrelated calls keep the short sandbox default).
 * Exported so the workflow MCP handlers can size their serialized-operation
 * deadline to the exact bound the sandbox will apply (issue #2981).
 */
export function buildExecOptionsForParams(
  baseDir: string,
  params: ExecToolParams,
  preferences: ExecToolPreferences | null | undefined,
  uat = false,
): ExecSandboxOptions {
  if (uat) {
    // Classify on the normalized params — the injected UAT purpose names the
    // checkId, which is part of what makes a UAT run verification-oriented.
    const normalized = normalizeUatExecParams(params as UatExecToolParams);
    if ("error" in normalized) return buildExecOptions(baseDir, preferences, undefined, false);
    return buildExecOptions(
      baseDir,
      preferences,
      undefined,
      isVerificationWorkload(normalized.params, normalized.params.script),
    );
  }
  const script = normalizeScript(params);
  return buildExecOptions(
    baseDir,
    preferences,
    undefined,
    typeof script === "string" && isVerificationWorkload(params, script),
  );
}

function isEnabled(prefs: ExecToolDeps["preferences"]): boolean {
  return isContextModeEnabled(prefs);
}

function paramError(message: string): ToolExecutionResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { operation: "gsd_exec", error: "invalid_params", detail: message },
    isError: true,
  };
}

function normalizeRuntime(value: unknown): ExecSandboxRequest["runtime"] | ToolExecutionResult {
  if (value === undefined || value === null || value === "") return "bash";
  if (typeof value !== "string") {
    return paramError(`invalid runtime "${String(value)}" — must be bash | node | python`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "bash" || normalized === "sh" || normalized === "shell") return "bash";
  if (normalized === "node" || normalized === "nodejs" || normalized === "js" || normalized === "javascript") return "node";
  if (normalized === "python" || normalized === "python3" || normalized === "py") return "python";
  return paramError(`invalid runtime "${value}" — must be bash | node | python`);
}

function normalizeScript(params: ExecToolParams): string | ToolExecutionResult {
  const candidates = [params.script, params.command, params.cmd, params.code];
  let sawNonString = false;
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "string") {
      sawNonString = true;
      continue;
    }
    if (candidate.trim().length > 0) return candidate;
  }
  if (sawNonString) {
    return paramError("script/command must be a non-empty string");
  }
  return paramError("script is required and must be a non-empty string");
}

function isVerificationWorkload(params: ExecToolParams, script: string): boolean {
  if (typeof params.purpose === "string" && /\b(?:build|test|verify|verification|lint|typecheck)\b/i.test(params.purpose)) {
    return true;
  }

  return script.split(/&&|\|\||[;|\n]/).some((statement) => {
    const invocation = statement.trim().match(/^(?:["']([^"']+)["']|(\S+))(?:\s+([\s\S]*))?$/);
    if (!invocation) return false;
    const executable = (invocation[1] ?? invocation[2] ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const args = invocation[3] ?? "";

    if (/^(?:npm|pnpm|yarn|bun)(?:\.(?:cmd|bat|exe))?$/.test(executable)) {
      return /\b(?:build|test|lint|typecheck|check|verify|verification)\b/i.test(args);
    }
    if (executable === "node" || executable === "node.exe") return /(?:^|\s)--test(?:\s|$)/.test(args);
    return /^(?:next|eslint|tsc|vitest|jest|pytest)(?:\.(?:cmd|bat|exe))?$/.test(executable);
  });
}

function normalizeRequiredString(value: unknown, field: string): string | ToolExecutionResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return paramError(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function normalizeUatIntent(value: unknown): UatExecIntent | ToolExecutionResult {
  if (typeof value !== "string") {
    return paramError(`intent is required and must be one of: ${UAT_EXEC_INTENTS.join(", ")}`);
  }
  const normalized = value.trim().toLowerCase();
  if ((UAT_EXEC_INTENTS as readonly string[]).includes(normalized)) return normalized as UatExecIntent;
  const alias = UAT_EXEC_INTENT_ALIASES[normalized];
  if (alias) return alias;
  return paramError(`invalid intent "${value}" — must be one of: ${UAT_EXEC_INTENTS.join(", ")}`);
}

function rejectUatScript(script: string): string | null {
  const patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|update|upgrade)\b/i, reason: "package dependency mutation is not allowed during UAT" },
    { re: /\b(?:pip|pip3|python\s+-m\s+pip)\s+install\b/i, reason: "package dependency mutation is not allowed during UAT" },
    { re: /\bgit\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|clean|rm|mv|tag|branch)\b/i, reason: "git mutations are not allowed during UAT" },
    { re: /\brm\s+-[^\n\r;|&]*r[^\n\r;|&]*f\b/i, reason: "destructive filesystem cleanup is not allowed during UAT" },
    { re: /\b(?:env|printenv)\b(?:\s|$)/i, reason: "dumping environment variables is not allowed during UAT" },
    { re: /\bcat\s+\.env(?:\b|\.|$)/i, reason: "reading credential files is not allowed during UAT" },
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(script)) return pattern.reason;
  }
  return null;
}

function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

/** The UAT check a gsd_uat_exec run belongs to. */
interface UatExecBinding {
  milestoneId: string;
  sliceId: string;
  checkId: string;
}

interface NormalizedUatExecError {
  error: ToolExecutionResult;
  params?: never;
  uat?: never;
}

interface NormalizedUatExecOk {
  error?: never;
  /** Exactly the params executeGsdExec will run (script resolved, purpose/metadata injected). */
  params: ExecToolParams & { script: string; purpose: string; metadata: Record<string, unknown> };
  uat: UatExecBinding;
  intent: UatExecIntent;
}

/**
 * Validate and normalize gsd_uat_exec params into the exact shape
 * executeGsdExec runs: script resolved, purpose defaulted from the UAT
 * coordinates, typed metadata attached. Shared with the workflow MCP
 * handlers so deadline sizing classifies the workload on the same params
 * the executor uses (issue #2981).
 */
function normalizeUatExecParams(params: UatExecToolParams): NormalizedUatExecError | NormalizedUatExecOk {
  const milestoneId = normalizeRequiredString(params.milestoneId, "milestoneId");
  if (isToolExecutionResult(milestoneId)) return { error: milestoneId };
  const sliceId = normalizeRequiredString(params.sliceId, "sliceId");
  if (isToolExecutionResult(sliceId)) return { error: sliceId };
  const checkId = normalizeRequiredString(params.checkId, "checkId");
  if (isToolExecutionResult(checkId)) return { error: checkId };
  const intent = normalizeUatIntent(params.intent);
  if (isToolExecutionResult(intent)) return { error: intent };
  const script = normalizeScript(params);
  if (isToolExecutionResult(script)) return { error: script };
  const rejected = rejectUatScript(script);
  if (rejected) {
    return {
      error: {
        content: [{ type: "text", text: `Error: gsd_uat_exec blocked command — ${rejected}` }],
        details: { operation: "gsd_uat_exec", error: "uat_exec_policy_block", reason: rejected },
        isError: true,
      },
    };
  }
  return {
    params: {
      ...params,
      script,
      purpose: typeof params.purpose === "string" && params.purpose.trim().length > 0
        ? params.purpose
        : `UAT ${milestoneId}/${sliceId}/${checkId} (${intent})`,
      metadata: {
        kind: "uat_exec",
        milestoneId,
        sliceId,
        checkId,
        intent,
        ...(typeof params.expected === "string" && params.expected.trim().length > 0
          ? { expected: params.expected.trim() }
          : {}),
      },
    },
    uat: { milestoneId, sliceId, checkId },
    intent,
  };
}

/** The Task whose open Attempt a gsd_exec call belongs to (#2982). */
export interface VerificationExecTaskRef {
  attemptId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

/** Default Task-ref lookup: the caller's open Task Attempt in the workflow DB. */
function readVerificationTaskRef(baseDir: string): VerificationExecTaskRef | null {
  const opened = openExistingWorkflowDatabase(baseDir);
  if (!opened.ok) return null;
  return currentCallerTaskRef(baseDir);
}

/**
 * The gate's exact invocation when `script` is a runnable command of the
 * calling Task's Verify field, with the Attempt it was resolved against
 * (#2982). Anything else — no open Attempt, no Task, prose verify, a
 * non-Verify script, a host without an invocation contract — keeps the
 * sandboxed allowlist run.
 */
function resolveVerificationExecInvocation(
  deps: ExecToolDeps,
  script: string,
): { invocation: VerificationCommandInvocation; attemptRef: string } | null {
  const taskRef = deps.readVerificationTaskRef
    ? deps.readVerificationTaskRef(deps.baseDir)
    : readVerificationTaskRef(deps.baseDir);
  if (!taskRef) return null;
  const task = getTask(taskRef.milestoneId, taskRef.sliceId, taskRef.taskId);
  if (!task?.verify) return null;
  for (const command of runnableTaskPlanCommands(task.verify)) {
    if (command !== script) continue;
    const invocation = verificationCommandInvocation(command, deps.baseDir);
    return invocation ? { invocation, attemptRef: taskRef.attemptId } : null;
  }
  return null;
}

/**
 * Store the run as an exec_runs row. Evidence checks read that row, so a run
 * outside a GSD project (no workflow database) is not evidence of anything.
 * Returns the reason when a project database exists and the run is not stored.
 */
function recordRun(
  baseDir: string,
  result: ExecSandboxResult,
  script: string,
  startedAt: Date,
  uat: UatExecBinding | undefined,
  verification?: { runContract: string; sourceRevision: string | null; attemptRef: string },
): string | null {
  try {
    const opened = openExistingWorkflowDatabase(baseDir);
    if (!opened.ok) {
      if (opened.reason === "missing-gsd-dir" || opened.reason === "missing-database") return null;
      return opened.error?.message ?? `workflow database ${opened.reason}`;
    }
    storeRun(baseDir, result, script, startedAt, uat, verification);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The run's output hash. Contract-bearing runs (#2982) hash each stream
 * separately via the gate's own `execRunOutputHash` — the single source both
 * sides share, so the formats can never drift — and moving text between the
 * two persisted files changes the hash. Sandboxed runs keep the legacy
 * `sha256:<stdout><stderr>` form.
 */
function computeOutputHash(
  result: ExecSandboxResult,
  framed: boolean,
): string {
  const readStream = (path: string): Buffer => {
    try {
      return readFileSync(path);
    } catch {
      // An unreadable output file must never lose the row: the recorded hash
      // then matches no file, so the gate refuses to reason over the output.
      return Buffer.from(`unreadable: ${basename(path)}`);
    }
  };
  if (framed) {
    return execRunOutputHash(readStream(result.stdout_path), readStream(result.stderr_path));
  }
  const hash = createHash("sha256");
  for (const path of [result.stdout_path, result.stderr_path]) {
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update(`unreadable: ${basename(path)}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function storeRun(
  baseDir: string,
  result: ExecSandboxResult,
  script: string,
  startedAt: Date,
  uat: UatExecBinding | undefined,
  verification?: { runContract: string; sourceRevision: string | null; attemptRef: string },
): void {
  recordExecRun({
    id: result.id,
    runtime: result.runtime,
    command: redactSecrets(script),
    cwd: baseDir,
    exit_code: result.exit_code,
    signal: result.signal,
    timedOut: result.timed_out,
    aborted: result.aborted === true,
    started_at: startedAt.toISOString(),
    duration_ms: result.duration_ms,
    output_hash: computeOutputHash(result, verification != null),
    // Only a UAT run or a verification-form run (#2982) stores the source
    // revision: reading it hashes every source file.
    ...(uat
      ? {
          kind: "uat_exec",
          ...uat,
          sourceRevision: readSourceRevisionForRecord(baseDir, loadEffectiveGSDPreferences(baseDir)?.preferences),
        }
      : {
          kind: "exec",
          ...(verification
            ? {
                runContract: verification.runContract,
                sourceRevision: verification.sourceRevision,
                attemptRef: verification.attemptRef,
              }
            : {}),
        }),
  });
}

export async function executeGsdExec(
  params: ExecToolParams,
  deps: ExecToolDeps,
  uat?: UatExecBinding,
): Promise<ToolExecutionResult> {
  if (!isEnabled(deps.preferences)) return contextModeDisabledResult("gsd_exec");

  const runtime = normalizeRuntime(params.runtime);
  if (isToolExecutionResult(runtime)) return runtime;
  const script = normalizeScript(params);
  if (isToolExecutionResult(script)) return script;
  if (Buffer.byteLength(script, "utf8") > 200_000) {
    return paramError("script exceeds the 200 KB length limit");
  }
  if (bashReferencesProjectRootOutsideWorktree(script, deps.baseDir)) {
    return paramError(
      "script references the original project root while running inside a milestone worktree; use the active worktree path or relative paths",
    );
  }

  const opts = buildExecOptions(
    deps.baseDir,
    deps.preferences,
    { env: deps.env, now: deps.now, generateId: deps.generateId, signal: deps.signal },
    isVerificationWorkload(params, script),
  );
  const run = deps.run ?? runExecSandbox;

  // With the opt-in reuse preference and the in-process capability (#2982),
  // a bash script that is a runnable command of the calling Task's Verify
  // field runs under the verification gate's own invocation instead of the
  // sandbox shell + allowlist. Every observed run of such a command records
  // its invocation contract, so a newer failed run is never skipped in favor
  // of an older passing one; the source revision is kept only when equal and
  // the run succeeded.
  const matchedVerification = !uat
    && deps.verificationRunContract === true
    && deps.preferences?.verification_reuse_exec_evidence === true
    && runtime === "bash"
    ? resolveVerificationExecInvocation(deps, script)
    : null;
  const verificationPrefs = matchedVerification
    ? loadEffectiveGSDPreferences(deps.baseDir)?.preferences
    : undefined;
  const sourceRevisionBefore = matchedVerification
    ? readSourceRevisionForRecord(deps.baseDir, verificationPrefs)
    : null;

  const startedAt = (deps.now ?? (() => new Date()))();
  let result: ExecSandboxResult;
  try {
    result = await run(
      {
        runtime,
        script,
        ...(typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
        ...(params.metadata && typeof params.metadata === "object" ? { metadata: params.metadata } : {}),
        ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
        ...(matchedVerification
          ? {
              invocation: {
                program: matchedVerification.invocation.program,
                args: matchedVerification.invocation.args,
                env: matchedVerification.invocation.env,
              },
            }
          : {}),
      },
      opts,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: gsd_exec failed — ${message}` }],
      details: { operation: "gsd_exec", error: message },
      isError: true,
    };
  }
  const formatted = formatResult(result, typeof params.purpose === "string" ? params.purpose : undefined);
  let verification: { runContract: string; sourceRevision: string | null; attemptRef: string } | undefined;
  if (matchedVerification) {
    // Every matched run records its contract — success, failure, timeout or
    // kill — so the gate's newest-run rule always sees the executor's latest
    // observation of this command. The revision is kept only for a clean
    // success whose persisted output is byte-faithful to what the child
    // wrote (no redaction or bounding) and whose source did not move.
    const succeeded = result.exit_code === 0 && result.signal === null && !result.timed_out;
    let sourceRevision: string | null = null;
    if (succeeded && result.output_transformed !== true && sourceRevisionBefore !== null) {
      const sourceRevisionAfter = readSourceRevisionForRecord(deps.baseDir, verificationPrefs);
      if (sourceRevisionAfter === sourceRevisionBefore) sourceRevision = sourceRevisionBefore;
    }
    verification = {
      runContract: execRunContractStorage(matchedVerification.invocation),
      sourceRevision,
      attemptRef: matchedVerification.attemptRef,
    };
  }
  const notRecorded = recordRun(deps.baseDir, result, script, startedAt, uat, verification);
  if (notRecorded === null) return formatted;
  return {
    ...formatted,
    content: [{
      type: "text",
      text: `${formatted.content[0]!.text}\n--- warning ---\nThe command ran, but the host did not record this run: ${notRecorded}. ` +
        "This run is not verification or UAT evidence. Do not run the command again only to get the output.",
    }],
    details: { ...formatted.details, run_not_recorded: notRecorded },
  };
}

export async function executeUatExec(
  params: UatExecToolParams,
  deps: ExecToolDeps,
): Promise<ToolExecutionResult> {
  const normalized = normalizeUatExecParams(params);
  if (normalized.error) return normalized.error;
  const { uat, intent } = normalized;

  const result = await executeGsdExec(normalized.params, deps, uat);
  const details = result.details ?? {};
  return {
    ...result,
    details: {
      ...details,
      operation: "gsd_uat_exec",
      milestoneId: uat.milestoneId,
      sliceId: uat.sliceId,
      checkId: uat.checkId,
      intent,
    },
  };
}

function formatResult(result: ExecSandboxResult, purpose?: string): ToolExecutionResult {
  const headerLines = [
    `gsd_exec[${result.id}] runtime=${result.runtime} exit=${formatExit(result)} duration=${result.duration_ms}ms`,
    `  stdout: ${result.stdout_bytes}B${result.stdout_truncated ? " (truncated)" : ""} → ${result.stdout_path}`,
    `  stderr: ${result.stderr_bytes}B${result.stderr_truncated ? " (truncated)" : ""} → ${result.stderr_path}`,
  ];
  // Issue #2927: failed executions append a separate, labeled bounded stderr
  // excerpt after the digest — streams stay separate (the digest remains the
  // stdout tail), successes are unchanged, and the section is additive so
  // historical result text keeps its shape.
  const sections = [`--- digest ---\n${result.digest}`];
  if (result.stderr_excerpt) sections.push(`--- stderr (tail) ---\n${result.stderr_excerpt}`);
  const summary = `${headerLines.join("\n")}\n${sections.join("\n")}`.trimEnd();
  return {
    content: [{ type: "text", text: summary }],
    details: {
      operation: "gsd_exec",
      id: result.id,
      runtime: result.runtime,
      exit_code: result.exit_code,
      signal: result.signal,
      timed_out: result.timed_out,
      aborted: result.aborted === true,
      force_resolved: result.force_resolved,
      duration_ms: result.duration_ms,
      stdout_bytes: result.stdout_bytes,
      stderr_bytes: result.stderr_bytes,
      stdout_truncated: result.stdout_truncated,
      stderr_truncated: result.stderr_truncated,
      stdout_path: result.stdout_path,
      stderr_path: result.stderr_path,
      meta_path: result.meta_path,
      // Additive (issue #2914): the purpose forwarded to the run, unchanged, and
      // the digest tail. `purpose` is absent (never null) when none was given;
      // renderers display-normalize it without mutating these values.
      ...(typeof purpose === "string" ? { purpose } : {}),
      digest: result.digest,
      // Additive (issue #2927): bounded labeled stderr diagnostics for failed
      // executions; absent (never null) when not applicable.
      ...(result.stderr_excerpt ? { stderr_excerpt: result.stderr_excerpt } : {}),
    },
    isError: result.aborted === true || result.timed_out || result.signal !== null || result.exit_code !== 0,
  };
}

function formatExit(result: ExecSandboxResult): string {
  // force_resolved means a non-closing (D-state) child was force-resolved past its
  // hard deadline rather than observed exiting; distinguish it from a clean timeout.
  if (result.aborted && result.force_resolved) return "aborted(force-killed)";
  if (result.aborted) return "aborted";
  if (result.force_resolved) return "timeout(force-killed)";
  if (result.timed_out) return "timeout";
  if (result.signal) return `signal:${result.signal}`;
  if (result.exit_code === null) return "null";
  return String(result.exit_code);
}
