// GSD Exec Sandbox — tool-output sandboxing for sub-sessions.
//
// Runs a script in a subprocess and persists stdout/stderr to
// `.gsd/exec/<id>.{stdout,stderr,meta.json}`. Only a short digest is
// returned to the calling agent's context, keeping large outputs
// (e.g. Playwright snapshots, issue dumps) out of the window.
//
// Inspired by mksglu/context-mode (Elastic License 2.0). Independent
// implementation — no upstream code incorporated.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getShellConfig, killProcessTree, SIGKILL_GRACE_MS, HARD_DEADLINE_MS } from "@gsd/pi-coding-agent";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import { redactSecrets } from "./redact-secrets.js";

export interface ExecSandboxRequest {
  /** Interpreter to use. */
  runtime: "bash" | "node" | "python";
  /** Script body. Executed via the runtime's -c equivalent. */
  script: string;
  /** Optional purpose/label recorded in meta.json. */
  purpose?: string;
  /** Optional structured metadata recorded in meta.json. */
  metadata?: Record<string, unknown>;
  /** Per-invocation timeout in ms. Clamped to `clamp_timeout_ms`. */
  timeout_ms?: number;
}

export interface ExecSandboxOptions {
  /** Project root. stdout/stderr persist under `<baseDir>/.gsd/exec/`. */
  baseDir: string;
  /** Absolute upper bound for the timeout. */
  clamp_timeout_ms: number;
  /** Default timeout if request omits one. */
  default_timeout_ms: number;
  /** Cap on persisted stdout bytes. Further output is truncated with a marker. */
  stdout_cap_bytes: number;
  /** Cap on persisted stderr bytes. */
  stderr_cap_bytes: number;
  /** Number of trailing stdout chars returned as the digest. */
  digest_chars: number;
  /** Env var allowlist (case-sensitive). PATH/HOME always forwarded. */
  env_allowlist: readonly string[];
  /** Optional override of process.env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Optional override for the current time (tests). */
  now?: () => Date;
  /** Optional override for id generation (tests). */
  generateId?: () => string;
  /** Optional request cancellation signal. Aborting kills the child process tree. */
  signal?: AbortSignal;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL on timeout.
   * Defaults to SIGKILL_GRACE_MS. Exposed as a test seam.
   */
  kill_grace_ms?: number;
  /**
   * Delay (ms) after a kill is initiated before the hard-deadline force-resolves
   * the promise (handles D-state / non-closing children).
   * Defaults to SIGKILL_GRACE_MS + HARD_DEADLINE_MS. Exposed as a test seam.
   */
  force_resolve_delay_ms?: number;
}

export interface ExecSandboxResult {
  id: string;
  runtime: ExecSandboxRequest["runtime"];
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  /** True when an external AbortSignal terminated the child process tree. */
  aborted?: boolean;
  /**
   * True when the result came from the hard-deadline force-resolve (a non-closing
   * D-state child that never emitted 'close') rather than an observed process exit.
   * In that case `signal` is the synthetic "SIGKILL" marker, not a delivered signal.
   */
  force_resolved: boolean;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_path: string;
  stderr_path: string;
  meta_path: string;
  digest: string;
  /**
   * Bounded, labeled tail of captured stderr, present only on failed
   * executions (nonzero/null exit, signal, timeout, or abort) that captured
   * stderr and whose digest does not already expose it (a plain failure with
   * empty stdout keeps its stderr-exposing marker instead of a duplicate
   * excerpt). Streams stay separate: the digest remains the stdout tail (or
   * its marker), this field carries the stderr diagnostics (issue #2927).
   */
  stderr_excerpt?: string;
}

const ALWAYS_FORWARD_ENV = ["PATH", "HOME"] as const;

// SIGKILL_GRACE_MS / HARD_DEADLINE_MS are imported from @gsd/pi-coding-agent
// (shell.ts) — the single source of truth for the graceful-kill timing ladder —
// so this sandbox can never drift from the canonical kill path it delegates to.

export const EXEC_DEFAULTS = {
  clampTimeoutMs: 600_000,
  defaultTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  stdoutCapBytes: 1_048_576,
  stderrCapBytes: 262_144,
  digestChars: 300,
  envAllowlist: [
    "LANG",
    "LC_ALL",
    "TERM",
    "TZ",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PYTHONIOENCODING",
  ] as const,
} as const;

function buildChildEnv(opts: ExecSandboxOptions): NodeJS.ProcessEnv {
  const source = opts.env ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  const allowed = new Set<string>([...ALWAYS_FORWARD_ENV, ...opts.env_allowlist]);
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function clampTimeout(request: ExecSandboxRequest, opts: ExecSandboxOptions): number {
  const requested = typeof request.timeout_ms === "number" && Number.isFinite(request.timeout_ms)
    ? Math.floor(request.timeout_ms)
    : opts.default_timeout_ms;
  if (requested < 1) return 1;
  if (requested > opts.clamp_timeout_ms) return opts.clamp_timeout_ms;
  return requested;
}

function resolveCommand(runtime: ExecSandboxRequest["runtime"]): { cmd: string; args: string[] } {
  switch (runtime) {
    case "bash":
      try {
        const { shell, args } = getShellConfig();
        return { cmd: shell, args };
      } catch {
        return { cmd: "bash", args: ["-c"] };
      }
    case "node":
      return { cmd: process.execPath, args: ["-e"] };
    case "python":
      return { cmd: "python3", args: ["-c"] };
  }
}

function sanitizeBashScriptForWindows(script: string): string {
  if (process.platform !== "win32") return script;
  // Git Bash can materialize literal `nul` files for NUL redirects.
  return script.replace(/(\d*>>?) *\bNUL\b(?=\s|;|\||&|\)|$)/gi, "$1 /dev/null");
}

function tail(buf: Buffer, chars: number): string {
  if (chars <= 0) return "";
  const text = buf.toString("utf-8");
  return text.length <= chars ? text : text.slice(text.length - chars);
}

/**
 * Run a script in a subprocess, capture stdout/stderr to files under
 * `.gsd/exec/<id>.{stdout,stderr,meta.json}`, and return an `ExecSandboxResult`
 * containing the digest plus metadata.
 *
 * Errors from spawn failures resolve (not reject) with `exit_code=null`.
 * The function is pure with respect to its inputs — no global state beyond
 * filesystem writes under `baseDir`.
 */
export function runExecSandbox(
  request: ExecSandboxRequest,
  opts: ExecSandboxOptions,
): Promise<ExecSandboxResult> {
  return new Promise((resolveP) => {
    const id = (opts.generateId ?? defaultGenerateId)();
    const now = (opts.now ?? (() => new Date()))();
    const execDir = resolve(opts.baseDir, ".gsd", "exec");
    if (!existsSync(execDir)) mkdirSync(execDir, { recursive: true });
    const stdoutPath = resolve(execDir, `${id}.stdout`);
    const stderrPath = resolve(execDir, `${id}.stderr`);
    const metaPath = resolve(execDir, `${id}.meta.json`);

    const timeoutMs = clampTimeout(request, opts);
    const { cmd, args } = resolveCommand(request.runtime);
    const script = request.runtime === "bash" ? sanitizeBashScriptForWindows(request.script) : request.script;
    const env = buildChildEnv(opts);
    const useProcessGroup = process.platform !== "win32";

    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, [...args, script], {
        cwd: opts.baseDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        ...(useProcessGroup ? { detached: true } : {}),
      });
    } catch (err) {
      const duration = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, `spawn error: ${message}\n`);
      const result: ExecSandboxResult = {
        id,
        runtime: request.runtime,
        exit_code: null,
        signal: null,
        timed_out: false,
        force_resolved: false,
        duration_ms: duration,
        stdout_bytes: 0,
        stderr_bytes: Buffer.byteLength(`spawn error: ${message}\n`),
        stdout_truncated: false,
        stderr_truncated: false,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        meta_path: metaPath,
        digest: `[spawn error: ${message}]`,
      };
      writeMeta(metaPath, result, request, now);
      resolveP(result);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = opts.stdout_cap_bytes - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = opts.stderr_cap_bytes - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      }
    });

    const effectiveGraceMs = opts.kill_grace_ms ?? SIGKILL_GRACE_MS;
    const effectiveForceResolveDelay = opts.force_resolve_delay_ms ?? (effectiveGraceMs + HARD_DEADLINE_MS);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killInitiated = false;
    let timer: NodeJS.Timeout | undefined;
    let forceResolveTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const removeAbortListener = () => {
      if (opts.signal && abortListener) {
        opts.signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    };

    const initiateKill = () => {
      if (killInitiated) return;
      killInitiated = true;
      // killProcessTree handles both platforms and kills the whole tree: on Unix
      // it signals the process group (SIGTERM -> grace -> SIGKILL); on Windows it
      // force-kills the tree via taskkill /F /T. Using child.kill("SIGTERM") here
      // would only terminate the direct child on Windows, orphaning grandchildren.
      if (child.pid != null) {
        killProcessTree(child.pid, { graceMs: effectiveGraceMs });
      } else {
        child.kill("SIGTERM");
      }
      // Arm hard-deadline force-resolve in case child never closes (D-state).
      // The "SIGKILL" here is a synthetic marker (the process may not have actually
      // received it); force_resolved=true records that this was a deadline, not an exit.
      forceResolveTimer = setTimeout(() => {
        finalize(null, "SIGKILL", true);
      }, effectiveForceResolveDelay);
      forceResolveTimer.unref?.();
    };

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null, forceResolved = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceResolveTimer);
      removeAbortListener();
      const duration = Date.now() - started;
      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      const stdoutSuffix = stdoutTruncated ? "\n[truncated: stdout cap reached]\n" : "";
      const stderrSuffix = stderrTruncated ? "\n[truncated: stderr cap reached]\n" : "";
      // Redact secret-shaped substrings before persisting to .gsd/exec/ (skipped by
      // the secret scanner). The returned digest is derived from the raw buffer
      // below and is redacted downstream when the session is written to activity/.
      writeFileSync(stdoutPath, redactSecrets(Buffer.concat([stdoutBuf, Buffer.from(stdoutSuffix, "utf-8")]).toString("utf-8")));
      writeFileSync(stderrPath, redactSecrets(Buffer.concat([stderrBuf, Buffer.from(stderrSuffix, "utf-8")]).toString("utf-8")));

      const digestBody = tail(stdoutBuf, opts.digest_chars);
      // Issue #2927: failed executions surface a bounded stderr excerpt
      // alongside stdout instead of losing failure diagnostics behind a
      // nonempty stdout. Streams stay separate — the digest remains the
      // stdout tail, the excerpt is its own labeled field — and semantics
      // stay authoritative: success never gains an excerpt. When stdout is
      // empty, a plain failure's digest marker already exposes the stderr
      // tail, so no duplicate excerpt is needed; the aborted/timed-out
      // markers carry no stderr, so those failures still get one. Bounded by
      // the existing digest budget; no new cap.
      const failed = aborted || timedOut || signal !== null || exitCode !== 0;
      const digestExposesStderr = digestBody.length === 0 && stderrBuf.length > 0 && !aborted && !timedOut;
      const stderrExcerpt =
        failed && stderrBuf.length > 0 && !digestExposesStderr
          ? tail(stderrBuf, opts.digest_chars)
          : "";

      const digest =
        digestBody.length > 0
          ? digestBody
          : aborted
            ? "[no stdout — aborted]"
            : timedOut
              ? "[no stdout — timed out]"
              : stderrBuf.length > 0
                ? `[no stdout — tail of stderr]\n${tail(stderrBuf, opts.digest_chars)}`
                : "[no output]";

      const result: ExecSandboxResult = {
        id,
        runtime: request.runtime,
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        aborted,
        force_resolved: forceResolved,
        duration_ms: duration,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        meta_path: metaPath,
        digest,
        ...(stderrExcerpt ? { stderr_excerpt: stderrExcerpt } : {}),
      };
      writeMeta(metaPath, result, request, now);
      resolveP(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      initiateKill();
    }, timeoutMs);
    timer.unref?.();

    if (opts.signal) {
      abortListener = () => {
        if (settled || timedOut) return;
        aborted = true;
        clearTimeout(timer);
        initiateKill();
      };
      if (opts.signal.aborted) {
        abortListener();
      } else {
        opts.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const line = `child error: ${message}\n`;
      const remaining = opts.stderr_cap_bytes - stderrBytes;
      if (remaining > 0) {
        const chunk = Buffer.from(line, "utf-8").subarray(0, remaining);
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        if (chunk.length < Buffer.byteLength(line, "utf-8")) stderrTruncated = true;
      }
    });
    child.on("close", (code, signal) => finalize(code, signal));
  });
}

function defaultGenerateId(): string {
  return randomUUID();
}

function writeMeta(
  path: string,
  result: ExecSandboxResult,
  request: ExecSandboxRequest,
  now: Date,
): void {
  const meta = {
    id: result.id,
    runtime: result.runtime,
    purpose: request.purpose ?? null,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    script_chars: request.script.length,
    started_at: now.toISOString(),
    finished_at: new Date(now.getTime() + result.duration_ms).toISOString(),
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
  };
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
}
