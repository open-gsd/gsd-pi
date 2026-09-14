
/**
 * Evidence cross-reference for auto-mode safety harness.
 * Compares the LLM's claimed verification evidence (command + exitCode)
 * against actual bash tool calls recorded by the evidence collector.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import type { BashEvidence, EvidenceEntry } from "./evidence-collector.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClaimedEvidence {
  command: string;
  exitCode: number;
  verdict: string;
  createdAt?: string;
}

export interface EvidenceMismatch {
  severity: "warning" | "error";
  claimed: ClaimedEvidence;
  actual: BashEvidence | null;
  reason: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Cross-reference claimed verification evidence against actual bash tool calls.
 *
 * Returns an array of mismatches. Empty array = all claims verified.
 * Skips entries that were coerced from strings (already flagged by db-tools.ts).
 */
export function crossReferenceEvidence(
  claimedEvidence: readonly ClaimedEvidence[],
  actualEvidence: readonly EvidenceEntry[],
): EvidenceMismatch[] {
  const bashCalls = actualEvidence.filter(
    (e): e is BashEvidence => e.kind === "bash",
  );
  const mismatches: EvidenceMismatch[] = [];

  for (const claimed of latestClaimBatch(claimedEvidence)) {
    // Skip coerced entries — they're already flagged with exitCode: -1
    // and verdict: "unknown (coerced from string)" by db-tools.ts
    if (claimed.verdict?.includes("coerced from string")) continue;
    if (claimed.exitCode === -1) continue;

    // Skip entries with empty or generic commands
    if (!claimed.command || claimed.command.length < 3) continue;

    // Find matching bash calls by command similarity. A command may be retried
    // after a failed first run; the newest matching execution is the one that
    // supports or rejects a claimed pass.
    const matches = findMatches(claimed.command, bashCalls);

    if (matches.length === 0) {
      mismatches.push({
        severity: "warning",
        claimed,
        actual: null,
        reason: `No bash tool call found matching "${claimed.command.slice(0, 80)}"`,
      });
      continue;
    }

    // A shell-spawn/infra failure means the command never ran (e.g. on Windows
    // `gsd_exec runtime=bash` resolves to a WSL with no /bin/bash). The LLM
    // typically recovers by re-running via another runtime, and that genuine
    // run may not even be in the match set. Such a failure is inconclusive, not
    // a falsified pass — exclude it before judging the exit code.
    const commandRuns = matches.filter((m) => !isInfraSpawnFailure(m));
    if (commandRuns.length === 0) {
      if (claimed.exitCode === 0) {
        mismatches.push({
          severity: "warning",
          claimed,
          actual: latestMatch(matches),
          reason:
            `Matched execution failed to spawn (infrastructure error, not a command failure); ` +
            `treating as inconclusive`,
        });
      }
      continue;
    }

    // Exit code mismatch: LLM claims success but actual command failed
    const match = latestMatch(commandRuns);
    if (claimed.exitCode === 0 && match.exitCode !== 0) {
      mismatches.push({
        severity: "error",
        claimed,
        actual: match,
        reason: exitCodeMismatchReason(claimed.command, match),
      });
    }
  }

  return mismatches;
}

/**
 * Runtime-spawn / shell-infra failure signatures. When a bash-runtime call
 * fails to *spawn* (rather than the command running and exiting non-zero), the
 * recorded exitCode is an ordinary non-zero but the output carries one of these
 * markers. Such a call is not evidence that a verification failed.
 */
const INFRA_SPAWN_FAILURE_SIGNATURES: readonly RegExp[] = [
  /execvpe\([^)]*\)\s+failed/i,   // WSL: execvpe(/bin/bash) failed: No such file or directory
  /WSL \(.*\) ERROR/i,            // WSL relay error banner
  /command not found:\s*(?:bash|sh|zsh|dash|fish|ash|ksh|wsl)\b/i, // missing shell interpreter only
];

/**
 * True when a non-zero bash call looks like a shell-spawn/infra failure (the
 * command never started) rather than a real command failure. A successful run
 * (exitCode 0) is never an infra failure.
 */
function isInfraSpawnFailure(call: BashEvidence): boolean {
  if (call.exitCode === 0) return false;
  const snippet = call.outputSnippet ?? "";
  if (snippet.length === 0) return false;
  return INFRA_SPAWN_FAILURE_SIGNATURES.some((re) => re.test(snippet));
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Verification evidence rows are append-only across retries, but a task
 * completion inserts one batch at a single created_at timestamp. When that
 * timestamp is present, safety should judge the newest completion claim only.
 */
function latestClaimBatch(
  claimedEvidence: readonly ClaimedEvidence[],
): readonly ClaimedEvidence[] {
  const dated = claimedEvidence
    .map((claim) => ({
      claim,
      time: typeof claim.createdAt === "string" ? Date.parse(claim.createdAt) : Number.NaN,
    }))
    .filter((entry) => Number.isFinite(entry.time));

  if (dated.length === 0) return claimedEvidence;

  const latestTime = Math.max(...dated.map((entry) => entry.time));
  return claimedEvidence.filter((claim) => (
    typeof claim.createdAt === "string" && Date.parse(claim.createdAt) === latestTime
  ));
}

/**
 * Find bash evidence entries matching a claimed command.
 * Uses substring matching — the claimed command may be a shortened version
 * of the actual command, or vice versa.
 */
function findMatches(
  claimedCommand: string,
  bashCalls: readonly BashEvidence[],
): BashEvidence[] {
  const normalized = claimedCommand.trim();

  const exact = bashCalls.filter((b) => b.command.trim() === normalized);

  // When an exact run exists, also consider wrapper-equivalent reruns (e.g.
  // `cd ... && <command>`) so a newer pass is not shadowed by a stale exact
  // failure. Do not merge arbitrary containing scripts: their exit code may
  // belong to later work, not to the claimed verification command.
  const scriptWrapped = bashCalls.filter((b) => {
    const command = b.command.trim();
    if (command.length === 0 || command === normalized) return false;
    return isWrapperEquivalentCommand(command, normalized);
  });
  if (exact.length > 0) return [...exact, ...scriptWrapped];

  // Substring match: claimed is contained in actual or actual in claimed.
  // A claimed verification command typically appears verbatim inside a
  // larger gsd_exec script body (cd prefix, multi-line scripts), so
  // script-containing-claim is the common direction. Blank-command entries
  // must be excluded — `"x".includes("")` is true, so they'd match anything.
  const substring = bashCalls.filter(
    (b) => b.command.trim().length > 0 &&
      (b.command.includes(normalized) || normalized.includes(b.command)),
  );
  if (substring.length > 0) return substring;

  // Token match: split on whitespace and check significant overlap. The score
  // only identifies WHICH command the claim refers to; it must not filter
  // WHICH outcome is authoritative — a passing re-run can score lower than the
  // superseded failures it replaces, and the newest matching run decides the
  // verdict (#2205).
  const claimedTokens = normalized.split(/\s+/).filter(t => t.length > 2);
  if (claimedTokens.length === 0) return [];

  return bashCalls.filter((call) => {
    const callTokens = new Set(call.command.split(/\s+/));
    const matchCount = claimedTokens.filter(t => callTokens.has(t)).length;
    return matchCount / claimedTokens.length >= 0.5;
  });
}

function latestMatch(matches: readonly BashEvidence[]): BashEvidence {
  return matches.reduce((latest, match) => (
    match.timestamp >= latest.timestamp ? match : latest
  ));
}

/**
 * Diagnostic for a claimed pass contradicted by the recorded execution.
 *
 * Provenance is decided by what the recorded execution actually is:
 * - the claim itself (exact, or with only shell wrapper noise) → the exit
 *   code genuinely belongs to the claimed command; original message.
 * - a compound execution (multi-line script or `&&`/`||`/`;` chain) → the
 *   recorded exit code is that execution's FINAL exit code, not the matched
 *   subcommand's (#2326); state execution reference, full script, and
 *   provenance explicitly.
 * - anything else (single command whose text differs from the claim) → the
 *   match is uncertain: name the recorded command; do not call it compound.
 */
function exitCodeMismatchReason(claimedCommand: string, match: BashEvidence): string {
  const base = `Claimed exitCode=0 but actual exitCode=${match.exitCode}`;
  const claimed = stripExecutionEvidenceLabel(claimedCommand.trim()).trim();
  const recorded = stripExecutionEvidenceLabel(match.command).trim();
  if (recorded === claimed || isWrapperEquivalentCommand(recorded, claimed)) {
    return base;
  }
  if (isCompoundRecordedCommand(recorded)) {
    return (
      `${base} — execution ${match.toolCallId} is a compound script: ${match.exitCode} is the ` +
      `FINAL exit code of the whole script, not the exit code of ` +
      `"${claimed.slice(0, 80)}". Full persisted script:\n${match.command}\n` +
      `Each passing closeout evidence item must come from an independently executed command.`
    );
  }
  return (
    `${base} — the claim does not exactly match the recorded command ` +
    `(recorded: ${summarizeCommand(recorded)}); exit code ${match.exitCode} belongs to that ` +
    `recorded command. Verification evidence must match the executed command exactly.`
  );
}

/** Operator chains and multi-line scripts: the exit code belongs to the whole execution. */
const COMMAND_CHAIN_RE = /&&|\|\||;/;

function isCompoundRecordedCommand(recorded: string): boolean {
  return recorded.includes("\n") || COMMAND_CHAIN_RE.test(recorded);
}

function summarizeCommand(recorded: string): string {
  return recorded.length > 160 ? `${recorded.slice(0, 157)}...` : recorded;
}

/**
 * Drop the `gsd_exec[ runtime]: purpose` label line the evidence collector
 * prefixes to gsd_exec / gsd_uat_exec bodies (see
 * formatExecutionEvidenceCommand), from BOTH the recorded command and the
 * claim — a claim copied verbatim from the persisted evidence carries the
 * label too.
 */
function stripExecutionEvidenceLabel(command: string): string {
  return command.replace(/^gsd_(?:uat_)?exec(?:_search)?(?:\s+\S+)?\s*:.*\n/, "");
}

/**
 * True when `actual` is the claimed command with only shell wrapper noise:
 * an optional leading `cd <dir> && ` prefix — the claim must be the FULL
 * remainder after it, since `cd x && claim && more` makes the recorded exit
 * code belong to the whole chain — and/or a trailing benign exit-code echo /
 * redirect suffix.
 */
function isWrapperEquivalentCommand(actual: string, claimed: string): boolean {
  let current = actual.trim();
  const cdPrefix = current.match(/^cd\s+.+?\s*&&\s*/);
  if (cdPrefix) {
    current = current.slice(cdPrefix[0].length).trim();
  }
  return withoutBenignWrapperSuffix(current) === claimed;
}

/**
 * Peel trailing benign exit-code echo / redirect wrappers
 * (`; echo EXIT=$?`, `> out.log`, `2>&1`, ...) so the underlying command can
 * be compared to the claim.
 */
function withoutBenignWrapperSuffix(command: string): string {
  let current = command.trim();
  for (;;) {
    const echo = current.match(/^(.+);\s*echo\s+["']?[A-Z_]*EXIT=\$\?["']?$/);
    if (echo) {
      current = echo[1].trim();
      continue;
    }
    const redirect = current.match(/^(.+?)\s+((?:\d?>>?|&>)\s*\S+|\d?>&\d)$/);
    if (redirect) {
      current = redirect[1].trim();
      continue;
    }
    return current;
  }
}
