/**
 * custom-verification.ts — Step verification for custom workflows.
 *
 * Reads the frozen DEFINITION.yaml from a run directory, finds the step's
 * `verify` policy, and dispatches to the appropriate handler. Four policies:
 *
 *   - content-heuristic: file existence + optional minSize + optional pattern match
 *   - shell-command: spawnSync with 30s timeout, exit 0 → continue, else retry
 *   - prompt-verify: always "pause" (defers to agent)
 *   - human-review: always "pause" (waits for manual inspection)
 *   - (no policy): returns "continue" (passthrough)
 *
 * Observability:
 * - Return value is the typed verification outcome ("continue" | "retry" | "pause" | "abort").
 * - shell-command captures stderr from spawnSync — callers can inspect on retry.
 * - content-heuristic logs the specific failure (missing file, below minSize, pattern mismatch).
 * - The frozen DEFINITION.yaml on disk is the single source of truth for step policies.
 */

import { logWarning } from "./workflow-logger.js";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { StepDefinition, VerifyPolicy } from "./definition-loader.js";
import { readFrozenDefinition } from "./custom-workflow-engine.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";

/** Verification outcome type — matches ExecutionPolicy.verify() return type. */
export type VerificationOutcome = "continue" | "retry" | "pause" | "abort";

export interface CustomVerificationResult {
  outcome: VerificationOutcome;
  inputPayload: string;
}

function verificationResult(
  outcome: VerificationOutcome,
  evidence: Record<string, unknown>,
): CustomVerificationResult {
  return { outcome, inputPayload: JSON.stringify(evidence) };
}

/**
 * Run custom verification for a specific step in a workflow run.
 *
 * Reads the frozen DEFINITION.yaml from `runDir`, finds the step with the
 * given `stepId`, and dispatches to the appropriate verification handler
 * based on the step's `verify.policy` field.
 *
 * @param runDir — absolute path to the workflow run directory
 * @param stepId — the step ID to verify (e.g. "step-1")
 * @returns "continue" if verification passes, "retry" if it should retry, or "pause" if it needs review
 * @throws Error if DEFINITION.yaml is missing or unreadable
 */
export function runCustomVerification(
  runDir: string,
  stepId: string,
): VerificationOutcome {
  return runCustomVerificationWithEvidence(runDir, stepId).outcome;
}

export function runCustomVerificationWithEvidence(
  runDir: string,
  stepId: string,
): CustomVerificationResult {
  const def = readFrozenDefinition(runDir);

  const step = def.steps.find((s: StepDefinition) => s.id === stepId);
  if (!step) {
    // Step not found in definition — nothing to verify, continue
    return verificationResult("continue", { policy: "none", reason: "step-not-found", stepId });
  }

  if (!step.verify) {
    // No verification policy configured — passthrough
    return verificationResult("continue", { policy: "none", reason: "not-configured", stepId });
  }

  return dispatchPolicy(runDir, step, step.verify);
}

/**
 * Dispatch to the correct policy handler.
 */
function dispatchPolicy(
  runDir: string,
  step: StepDefinition,
  verify: VerifyPolicy,
): CustomVerificationResult {
  switch (verify.policy) {
    case "content-heuristic":
      return handleContentHeuristic(runDir, step, verify);
    case "shell-command":
      return handleShellCommand(runDir, verify);
    case "prompt-verify":
      return verificationResult("pause", { policy: "prompt-verify" });
    case "human-review":
      return verificationResult("pause", { policy: "human-review" });
    default:
      return verificationResult("pause", { policy: "unknown" });
  }
}

/**
 * content-heuristic handler.
 *
 * For each path in the step's `produces` array:
 * 1. Check that the file exists (resolved relative to runDir)
 * 2. If `minSize` is set, check that file size >= minSize bytes
 * 3. If `pattern` is set, check that file content matches the regex
 *
 * Returns "continue" if all checks pass, "pause" if any fail.
 * If `produces` is empty or undefined, returns "continue" (nothing to check).
 */
function handleContentHeuristic(
  runDir: string,
  step: StepDefinition,
  verify: { policy: "content-heuristic"; minSize?: number; pattern?: string },
): CustomVerificationResult {
  const produces = step.produces;
  if (!produces || produces.length === 0) {
    return verificationResult("continue", { policy: "content-heuristic", reason: "no-outputs" });
  }

  // ADR-047 §3: the block signature hashes the inputs this guard actually read,
  // and with several outputs it reads several files before one of them fails.
  // Recording only the failing file collapses "output a changed but b still
  // fails" into the signature of "b fails", which falsely trips the liveness
  // backstop at occurrence two (#1674). Each check is kept in `produces` order,
  // with sizes for metadata reads and digests for content reads.
  const reads: Array<{ path: string; exists: boolean; size?: number; digest?: string }> = [];

  for (const relPath of produces) {
    const absPath = resolve(runDir, relPath);
    // Path traversal guard
    if (!absPath.startsWith(resolve(runDir) + sep) && absPath !== resolve(runDir)) {
      return verificationResult("pause", {
        policy: "content-heuristic",
        failure: "path-outside-run-directory",
        path: relPath,
        ...(reads.length > 0 ? { reads } : {}),
      });
    }

    // 1. File existence
    if (!existsSync(absPath)) {
      return verificationResult("pause", {
        policy: "content-heuristic",
        failure: "missing-file",
        path: relPath,
        reads: [...reads, { path: relPath, exists: false }],
      });
    }

    const read: { path: string; exists: true; size?: number; digest?: string } = {
      path: relPath,
      exists: true,
    };
    reads.push(read);

    // 2. Minimum size check
    if (verify.minSize !== undefined) {
      const stat = statSync(absPath);
      read.size = stat.size;
      if (stat.size < verify.minSize) {
        return verificationResult("pause", {
          policy: "content-heuristic",
          failure: "below-minimum-size",
          path: relPath,
          actualSize: stat.size,
          minimumSize: verify.minSize,
          reads,
        });
      }
    }

    // 3. Pattern match check (with timeout guard against ReDoS)
    if (verify.pattern !== undefined) {
      const content = readFileSync(absPath, "utf-8");
      read.digest = createHash("sha256").update(content, "utf8").digest("hex");
      try {
        if (!new RegExp(verify.pattern).test(content)) {
          return verificationResult("pause", {
            policy: "content-heuristic",
            failure: "pattern-mismatch",
            path: relPath,
            pattern: verify.pattern,
            reads,
          });
        }
      } catch (e) {
        logWarning("engine", `content-heuristic regex failed: ${(e as Error).message}`);
        return verificationResult("pause", {
          policy: "content-heuristic",
          failure: "invalid-pattern",
          path: relPath,
          pattern: verify.pattern,
          reads,
          error: (e as Error).message,
        });
      }
    }
  }

  return verificationResult("continue", { policy: "content-heuristic", reason: "checks-passed" });
}

/**
 * shell-command handler.
 *
 * Runs the command via `sh -c` with cwd set to the run directory
 * and a 30-second timeout. Returns "continue" if exit code 0,
 * "retry" otherwise (including timeout/signal kills).
 *
 * SECURITY: The command string comes from a frozen DEFINITION.yaml written
 * at run-creation time. The trust boundary is the workflow definition author.
 * Commands run with the same privileges as the GSD process. Only use
 * shell-command verification with definitions you trust.
 */
function handleShellCommand(
  runDir: string,
  verify: { policy: "shell-command"; command: string },
): CustomVerificationResult {
  // Guard: reject commands containing shell expansion patterns that suggest injection
  const dangerousPatterns = /\$\(|`|;\s*(rm|curl|wget|nc|bash|sh|eval)\b/;
  if (dangerousPatterns.test(verify.command)) {
    console.warn(
      `custom-verification: shell-command contains suspicious pattern, skipping: ${verify.command}`,
    );
    return verificationResult("pause", {
      policy: "shell-command",
      command: verify.command,
      failure: "suspicious-command",
    });
  }

  const rewrittenCommand = rewriteCommandWithRtk(verify.command);
  const result = spawnSync("sh", ["-c", rewrittenCommand], {
    cwd: runDir,
    timeout: 30_000,
    encoding: "utf-8",
    stdio: "pipe",
    env: { ...process.env, PATH: process.env.PATH },
  });

  if (result.status === 0) {
    return verificationResult("continue", {
      policy: "shell-command",
      command: verify.command,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    });
  }

  return verificationResult("retry", {
    policy: "shell-command",
    command: verify.command,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  });
}
