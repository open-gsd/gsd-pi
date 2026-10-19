
/**
 * Evidence cross-reference for auto-mode safety harness.
 * Compares the LLM's claimed verification evidence (command + exitCode)
 * against actual bash tool calls recorded by the evidence collector.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { INCONCLUSIVE_EXIT_CODE } from "./evidence-collector.js";
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

    // A compound claim (`a && b`) is resolved in three steps (#2665):
    // 1. Recordings of the whole chain itself (exact, behind a `cd` prefix,
    //    or behind the collector's gsd_exec label) are authoritative: the
    //    chain's exit code is its own outcome, and per-part matching must not
    //    override it with standalone history — older or newer.
    // 2. Otherwise each part is judged on its own recorded executions: an
    //    `&&` chain that exited 0 ran and passed every part, so every part
    //    must match a passing recording.
    // 3. A part with no recording falls back to whole-claim matching.
    // Claims copied from persisted evidence can carry the collector label
    // too — normalize both sides before splitting and comparing.
    const normalizedChain = stripExecutionEvidenceLabel(claimed.command).trim();
    const chainParts = splitTopLevelAnd(normalizedChain);
    if (chainParts) {
      const chainRuns = bashCalls.filter((call) => {
        const recorded = stripExecutionEvidenceLabel(call.command).trim();
        return recorded.length > 0 &&
          (recorded === normalizedChain || isWrapperEquivalentCommand(recorded, normalizedChain));
      });
      if (chainRuns.length > 0) {
        const outcome = judgeClaimedCommand(claimed, claimed.command, bashCalls, chainRuns);
        if (outcome.matched) {
          mismatches.push(...outcome.mismatches);
        }
        continue;
      }
      const partMismatches = judgeChainParts(chainParts, claimed, bashCalls);
      if (partMismatches) {
        mismatches.push(...partMismatches);
        continue;
      }
    }

    const outcome = judgeClaimedCommand(claimed, claimed.command, bashCalls);

    if (!outcome.matched) {
      mismatches.push({
        severity: "warning",
        claimed,
        actual: null,
        reason: `No bash tool call found matching "${claimed.command.slice(0, 80)}"`,
      });
      continue;
    }
    mismatches.push(...outcome.mismatches);
  }

  return mismatches;
}

// ─── Internals ──────────────────────────────────────────────────────────────

type ClaimJudgment = { matched: false } | { matched: true; mismatches: EvidenceMismatch[] };

/**
 * Match one claimed command against the recorded bash executions and judge
 * its exit code. Shared by single claims and the individual parts of a
 * compound claim (#2665). `restrictedMatches` (a preselected match set, e.g.
 * the whole-chain recordings of a compound claim) replaces findMatches.
 */
function judgeClaimedCommand(
  claimed: ClaimedEvidence,
  command: string,
  bashCalls: readonly BashEvidence[],
  restrictedMatches?: readonly BashEvidence[],
): ClaimJudgment {
  // Find matching bash calls by command similarity. A command may be retried
  // after a failed first run; the newest matching execution is the one that
  // supports or rejects a claimed pass.
  const matches = restrictedMatches ?? findMatches(command, bashCalls);

  if (matches.length === 0) return { matched: false };

  // A shell-spawn/infra failure means the command never ran (e.g. on Windows
  // `gsd_exec runtime=bash` resolves to a WSL with no /bin/bash). A harness
  // deadline (#2425) means the run's exit was never observed. Either way the
  // outcome is inconclusive, not a falsified pass — exclude it before judging
  // the exit code.
  const commandRuns = matches.filter((m) => !isInfraSpawnFailure(m));
  if (commandRuns.length === 0) {
    if (claimed.exitCode === 0) {
      return {
        matched: true,
        mismatches: [{
          severity: "warning",
          claimed,
          actual: latestMatch(matches),
          reason:
            `Matched execution never observed a real outcome (infrastructure error or harness deadline, not a command failure); ` +
            `treating as inconclusive`,
        }],
      };
    }
    return { matched: true, mismatches: [] };
  }

  // Exit code mismatch: LLM claims success but actual command failed
  const match = latestMatch(commandRuns);
  if (claimed.exitCode === 0 && match.exitCode !== 0) {
    return {
      matched: true,
      mismatches: [{
        severity: "error",
        claimed,
        actual: match,
        reason: exitCodeMismatchReason(command, match),
      }],
    };
  }
  return { matched: true, mismatches: [] };
}

/**
 * Judge each part of a compound claim (`a && b`) against its own recorded
 * executions (#2665). Returns null when any part has no matching execution —
 * the caller then falls back to whole-claim matching. Mismatches against the
 * same recorded execution are coalesced into one row: one falsifying run is
 * one mismatch, however many chain parts it dooms.
 */
function judgeChainParts(
  parts: readonly string[],
  claimed: ClaimedEvidence,
  bashCalls: readonly BashEvidence[],
): EvidenceMismatch[] | null {
  const mismatches: EvidenceMismatch[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const outcome = judgeClaimedCommand(claimed, part, bashCalls);
    if (!outcome.matched) return null;
    for (const mismatch of outcome.mismatches) {
      const key = mismatch.actual?.toolCallId ?? `${mismatch.severity}:${mismatch.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mismatches.push(mismatch);
    }
  }
  return mismatches;
}

/**
 * Split a claimed command on top-level `&&`, respecting single- and
 * double-quoted segments (#2665). Returns the trimmed parts only when the
 * command is a genuine multi-part `&&` chain with no other shell structure;
 * null otherwise, so the caller falls back to whole-claim matching. Bail
 * cases: single commands, empty parts, unterminated quotes, command
 * substitution (`$(`, backticks — anywhere, since their quoting is
 * independent of the surrounding segment), and any unquoted
 * parenthesis/grouping, pipeline `|`, or `;` — their exit-code semantics
 * differ from a plain `&&` chain, so per-part pass requirements would be
 * wrong.
 */
export function splitTopLevelAnd(command: string): string[] | null {
  // Command substitution executes wherever it appears — quoted or not — and
  // its quoting is independent of the surrounding segment, so any `$(` or
  // backtick makes per-part attribution unreliable: keep whole-claim matching.
  if (command.includes("$(") || command.includes("`")) return null;
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      current += ch;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      current += ch;
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
    if (!inSingle && !inDouble) {
      if (ch === "&" && command[i + 1] === "&") {
        parts.push(current);
        current = "";
        i += 1;
        continue;
      }
      // Newlines separate script statements: line-wise execution means a
      // trailing line can decide the outcome independently of the chain.
      if (ch === "\n" || ch === "\r") return null;
      // Other operators and grouping change which exit code belongs to which
      // sub-command: do not claim per-part semantics for them.
      if (ch === "|" || ch === ";" || ch === "(" || ch === ")" || ch === "`") return null;
    }
    current += ch;
  }
  if (inSingle || inDouble) return null;
  parts.push(current);
  if (parts.length < 2) return null;
  const trimmedParts = parts.map((part) => part.trim());
  if (trimmedParts.some((part) => part.length === 0)) return null;
  return trimmedParts;
}

/**
 * Runtime-spawn / harness-level inconclusive signatures. When a bash-runtime
 * call fails to *spawn* (rather than the command running and exiting non-zero),
 * the recorded outcome carries one of these markers. Such a call is not
 * evidence that a verification failed.
 */
const INFRA_SPAWN_FAILURE_SIGNATURES: readonly RegExp[] = [
  /execvpe\([^)]*\)\s+failed/i,   // WSL: execvpe(/bin/bash) failed: No such file or directory
  /WSL \(.*\) ERROR/i,            // WSL relay error banner
  /command not found:\s*(?:bash|sh|zsh|dash|fish|ash|ksh|wsl)\b/i, // missing shell interpreter only
];

/** The MCP workflow queue deadline rejection (#2425, workflow-tools.ts). */
const WORKFLOW_DEADLINE_RE = /Workflow operation exceeded \d+ms deadline/;

/**
 * Markers of an exit the harness actually observed (mirrors the collector's
 * resolveExitCode resolvers). A run with one of these must be judged on its
 * recorded exit even if its output also mentions the deadline signature.
 */
const OBSERVED_EXIT_RE = /Command exited with code \d+|"exit_code"\s*:\s*-?\d+/;

/**
 * True when a non-zero bash call looks like a shell-spawn/infra failure (the
 * command never started) or an unobserved outcome (#2425 sentinel) rather than
 * a real command failure. A successful run (exitCode 0) is never an infra
 * failure.
 */
function isInfraSpawnFailure(call: BashEvidence): boolean {
  if (call.exitCode === 0) return false;
  // Explicit inconclusive sentinel from the collector (#2425): the harness
  // never observed a process exit, so there is no failure to judge.
  if (call.exitCode === INCONCLUSIVE_EXIT_CODE) return true;
  const snippet = call.outputSnippet ?? "";
  if (snippet.length === 0) return false;
  // Deadline text in the output is only inconclusive when no exit was
  // observed (#2425): a run that exited on its own and merely printed the
  // deadline signature (e.g. a test or grep over source) must be judged on
  // its recorded exit. Covers pre-sentinel rows recorded as exit 1.
  if (WORKFLOW_DEADLINE_RE.test(snippet)) {
    return !OBSERVED_EXIT_RE.test(snippet);
  }
  return INFRA_SPAWN_FAILURE_SIGNATURES.some((re) => re.test(snippet));
}

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
 * Drop a leading `cd <path> && ` prefix from a chain, quote-aware: the path
 * may contain quoted `&&` (`cd "/work/a && b" && npm test`), which the
 * previous regex split at. Returns null when there is no top-level `&&` (or
 * quotes never close) — the command is not a verifiable cd-prefixed chain.
 */
function stripTopLevelCdPrefix(command: string): string | null {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
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
    // The cd prefix is a single command: an unquoted newline means later
    // lines are separate statements, not part of the cd argument.
    if (!inSingle && !inDouble && (ch === "\n" || ch === "\r")) return null;
    if (!inSingle && !inDouble && ch === "&" && command[i + 1] === "&") {
      return command.slice(i + 2).trim();
    }
  }
  return null;
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
  if (/^cd\s/.test(current)) {
    const stripped = stripTopLevelCdPrefix(current);
    // No top-level `&&` (or unterminated quotes): not a cd-prefixed CHAIN, so
    // nothing is stripped — suffix normalization below still applies (e.g.
    // `cd /work > out.log` compares as `cd /work`).
    if (stripped !== null) current = stripped;
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
