
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
        reason: `Claimed exitCode=0 but actual exitCode=${match.exitCode}`,
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

/** True when `actual` is the same command with only shell wrapper noise. */
function isWrapperEquivalentCommand(actual: string, claimed: string): boolean {
  const claimIndex = actual.lastIndexOf(claimed);
  if (claimIndex < 0) return false;

  const prefix = actual.slice(0, claimIndex).trim();
  if (prefix.length > 0 && !/^cd\s+.+\s+&&$/.test(prefix)) return false;

  const suffix = actual.slice(claimIndex + claimed.length).trim();
  return suffix.length === 0 || isBenignWrapperSuffix(suffix);
}

function isBenignWrapperSuffix(suffix: string): boolean {
  if (/^;\s*echo\s+["']?[A-Z_]*EXIT=\$\?["']?$/.test(suffix)) return true;
  return /^(?:(?:\d?>>?|&>)\s*\S+|\d?>&\d)(?:\s+(?:(?:\d?>>?|&>)\s*\S+|\d?>&\d))*$/.test(suffix);
}
