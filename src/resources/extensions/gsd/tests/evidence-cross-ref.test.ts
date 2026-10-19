// Project/App: gsd-pi
// File Purpose: Tests for verification evidence cross-reference mismatch policy.

import test from "node:test";
import assert from "node:assert/strict";

import { crossReferenceEvidence, splitTopLevelAnd } from "../safety/evidence-cross-ref.ts";
import {
  getEvidence,
  recordToolCall,
  recordToolResult,
  resetEvidence,
} from "../safety/evidence-collector.ts";
import type { BashEvidence, EvidenceEntry } from "../safety/evidence-collector.ts";
import { isTaskAttemptAwaitingVerification } from "../task-execution-domain-operation.ts";

test("evidence cross-reference waits for the canonical succeeded verify-stage Result", () => {
  assert.equal(isTaskAttemptAwaitingVerification(null), false);
  assert.equal(isTaskAttemptAwaitingVerification({
    state: "running",
    nextStage: "execute",
  }), false);
  assert.equal(isTaskAttemptAwaitingVerification({
    state: "settled",
    outcome: "succeeded",
    nextStage: "verify",
  }), true);
  assert.equal(isTaskAttemptAwaitingVerification({
    state: "settled",
    outcome: "failed",
    nextStage: "route",
  }), false);
});

test("claims of passing verification become errors when recorded bash evidence failed", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm test",
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("passing retry evidence is not invalidated by an earlier failed run of the same command", () => {
  const command = "node todo.js add 'Task A' && node todo.js add 'Task B' && node todo.js done 1";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "Task #1 not found",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command,
        exitCode: 0,
        outputSnippet: "Marked #1 done.",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("newer script-wrapped pass is not shadowed by a stale exact failing run", () => {
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: `cd /work && ${command}`,
        exitCode: 0,
        outputSnippet: "passed",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("token-matched verification is judged by its newest run, not the highest-scoring one", () => {
  // Issue #2205: three runs share verification vocabulary. The newest run (the
  // genuine pass) scores lowest on token overlap (0.5 vs 1.0 / 0.75), so the
  // bestScore filter kept only the superseded failures and the harness flagged
  // a passing task. Token overlap identifies WHICH command; the newest run of
  // that command is the authoritative outcome.
  const claim = "node test persistence verify";
  const mismatches = crossReferenceEvidence(
    [{ command: claim, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "fake persistence verify node test idempotency",
        exitCode: 1,
        outputSnippet: "Error: invariant violated",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "runtime persistence node test fake proof",
        exitCode: 1,
        outputSnippet: "Error: module not found",
        timestamp: 2,
      },
      {
        kind: "bash",
        toolCallId: "call-3",
        command: "verify node fake idempotency proof",
        exitCode: 0,
        outputSnippet: "ALL_OK",
        timestamp: 3,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a newest token-matched failure still flags after earlier passing runs", () => {
  // Complement of #2205: newest-run authority must not hide a failure. When
  // the newest token-matched run failed, the claimed pass is still falsified
  // even though older runs passed.
  const claim = "node test persistence verify";
  const mismatches = crossReferenceEvidence(
    [{ command: claim, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "fake persistence verify node test idempotency",
        exitCode: 0,
        outputSnippet: "ALL_OK",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "runtime persistence node test fake proof",
        exitCode: 0,
        outputSnippet: "ALL_OK",
        timestamp: 2,
      },
      {
        kind: "bash",
        toolCallId: "call-3",
        command: "verify node fake idempotency proof",
        exitCode: 1,
        outputSnippet: "Error: invariant violated",
        timestamp: 3,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("later containing script does not override an exact successful run", () => {
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 0,
        outputSnippet: "passed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: `cd /work && ${command} && npm run lint`,
        exitCode: 1,
        outputSnippet: "lint failed",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("same-timestamp retry evidence prefers the later recorded run", () => {
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command,
        exitCode: 0,
        outputSnippet: "passed",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("stale verification evidence batches are ignored when a newer completion batch exists", () => {
  const command = "node todo.js add 'Task A' && node todo.js add 'Task B' && node todo.js done 1";
  const resetCommand = `rm -f "$HOME/.config/todo/data.json" && ${command}`;
  const mismatches = crossReferenceEvidence(
    [
      { command, exitCode: 0, verdict: "pass", createdAt: "2026-05-14T11:16:48.588Z" },
      { command, exitCode: 1, verdict: "fail before reset", createdAt: "2026-05-14T11:28:36.952Z" },
      { command: resetCommand, exitCode: 0, verdict: "pass after reset", createdAt: "2026-05-14T11:28:36.952Z" },
    ],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "Task #1 not found",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: resetCommand,
        exitCode: 0,
        outputSnippet: "Marked #1 done.",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("WSL bash-spawn failure is not flagged as a falsified passing verification", () => {
  // Issue #814: on Windows, `gsd_exec runtime=bash` resolves to a WSL with no
  // /bin/bash. The bash-runtime verification call exits 1 with a spawn-failure
  // banner (the command never ran); the LLM re-ran via a node runtime (exit 0)
  // that findMatches does not capture. The infra failure must not block.
  const command = "npx playwright test e2e/m039-s05-comparison-legibility.spec.ts";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: `${command} --reporter=line 2>&1 | tail -40`,
        exitCode: 1,
        outputSnippet:
          "<3>WSL (12 - Relay) ERROR: CreateProcessCommon:800: execvpe(/bin/bash) failed: No such file or directory",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /inconclusive/);
});

test("missing tool failure (command not found: eslint) is a real error, not an infra spawn failure", () => {
  // Regression for overly-broad spawn signature: `command not found: eslint`
  // is a genuine verification failure (eslint not installed), not a missing
  // shell interpreter. It must produce a blocking error, not a warning.
  const command = "eslint src/";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "zsh: command not found: eslint",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("missing tool failure (command not found: node) is a real error, not an infra spawn failure", () => {
  // node is not a shell interpreter; its absence is a genuine env problem,
  // not a shell-spawn infra failure.
  const command = "node --test tests/verify.test.js";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 127,
        outputSnippet: "bash: command not found: node",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("missing shell interpreter (command not found: bash) is treated as an infra spawn failure", () => {
  // bash itself missing is the shell-spawn infra case; must remain a warning.
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "command not found: bash",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /inconclusive/);
});

test("missing recorded bash evidence remains a warning", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
});

test("claimed command absent from bash calls reports a warning mismatch with null actual", () => {
  // Regression: postUnitPreVerification flags fabricated evidence by filtering
  // crossReferenceEvidence mismatches on `severity === "warning" && actual === null`.
  // A claimed command with no matching bash call must produce exactly that shape,
  // otherwise fabricated evidence silently bypasses the safety check.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run verify", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "ls -la",
        exitCode: 0,
        outputSnippet: "files",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  const missing = mismatches.filter((m) => m.severity === "warning" && m.actual === null);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].actual, null);
});

test("accepted tradeoff: a newer overlapping command passing masks an older same-vocabulary failure (#2205 review)", () => {
  // Codex review case, pinned as an ACCEPTED tradeoff of newest-run authority
  // in the fuzzy token tier: an older failure of the claimed command is masked
  // when a newer, only partially-overlapping command passes. The alternative
  // (bestScore outcome filtering) was the #2205 wedge itself — it let a
  // superseded failed run out-vote a newer pass. If this masking ever matters
  // in practice, the fix is a command-family grouping, not score filtering.
  const claim = "node --test tests/auth.test.js";
  const mismatches = crossReferenceEvidence(
    [{ command: claim, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "node --test --test-reporter=spec tests/auth.test.js",
        exitCode: 1,
        outputSnippet: "tests/auth.test.js failing",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "node --test tests/unrelated.test.js",
        exitCode: 0,
        outputSnippet: "unrelated pass",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});
test("MCP workflow deadline timeout is recorded as the inconclusive sentinel -2, not exit 1 (#2425)", () => {
  // resolveExitCode must not encode an unobserved outcome as a failure: the
  // workflow queue deadline rejects while the underlying run keeps going and
  // usually exits 0. -2 is the collector's INCONCLUSIVE_EXIT_CODE sentinel.
  resetEvidence();
  recordToolCall("tc-deadline", "gsd_exec", { command: "pnpm -r test:integration" });
  recordToolResult(
    "tc-deadline",
    "gsd_exec",
    "Error: Workflow operation exceeded 300000ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)",
    true,
  );

  const entry = getEvidence().find((e) => e.toolCallId === "tc-deadline") as BashEvidence | undefined;
  assert.ok(entry, "deadline-timeouted call must be recorded");
  assert.equal(entry.exitCode, -2);
});

test("an observed exit wins over a deadline mention in output (#2425)", () => {
  // A result that merely contains the deadline signature (e.g. a verification
  // grep over source) still records its real, observed exit code.
  resetEvidence();
  recordToolCall("tc-grep", "bash", { command: "grep -r 'Workflow operation exceeded 300000ms deadline' src" });
  recordToolResult(
    "tc-grep",
    "bash",
    "src/mcp/workflow-tools.ts:1284: Workflow operation exceeded 300000ms deadline\nCommand exited with code 0",
    false,
  );

  const entry = getEvidence().find((e) => e.toolCallId === "tc-grep") as BashEvidence | undefined;
  assert.ok(entry, "grep call must be recorded");
  assert.equal(entry.exitCode, 0);
});

test("deadline-timeouted verification is an inconclusive warning, not a falsified pass (#2425)", () => {
  const command = "pnpm -r test:integration";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: -2,
        outputSnippet: "Error: Workflow operation exceeded 300000ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /inconclusive/);
});

test("pre-fix deadline rows recorded as exit 1 are still inconclusive via the deadline signature (#2425)", () => {
  // Evidence persisted before the sentinel existed carries exitCode 1 with the
  // deadline text in the snippet; the signature must catch those too.
  const command = "pnpm -r test:integration";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "Workflow operation exceeded 300000ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /inconclusive/);
});

test("an observed failure whose output mentions the deadline is a real error, not inconclusive (#2425 review)", () => {
  // The run exited on its own (prose marker, exit 1) and merely printed the
  // deadline signature; it must be judged on its recorded exit.
  const command = "pnpm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "Workflow operation exceeded 300000ms deadline\nCommand exited with code 1",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("an older real failure followed by a deadline-timeouted retry still blocks (newest observed authority)", () => {
  // The deadline retry is inconclusive, but no observed pass exists; the
  // newest OBSERVED outcome is the failure. Same newest-run authority the
  // WSL-infra path already applies (#2205 accepted tradeoff).
  const command = "pnpm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "tests failed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command,
        exitCode: -2,
        outputSnippet: "Workflow operation exceeded 300000ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("an older observed pass followed by a deadline-timeouted run stays clean (newest observed authority)", () => {
  const command = "pnpm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 0,
        outputSnippet: "all green",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command,
        exitCode: -2,
        outputSnippet: "Workflow operation exceeded 300000ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

// ─── Compound-claim per-part matching (#2665) ───────────────────────────────

test("a compound claim verified per part when each part ran separately (#2665)", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && npm run typecheck", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run lint",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm run typecheck",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a compound claim fails when any part's newest execution failed (#2665)", () => {
  // Safety hole closed: the newest matching execution overall was the passing
  // typecheck run, so whole-claim matching passed the chain while the lint
  // part's newest run had failed. Per-part judging catches it.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && npm run typecheck", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run lint",
        exitCode: 1,
        outputSnippet: "lint errors",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm run typecheck",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0 but actual exitCode=1/);
});

test("a compound claim with a part recorded only inside a compound run is judged on that run (#2665)", () => {
  // A passing compound recording proves every part of an `&&` chain passed,
  // so a part matched only inside the script passes with it.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && npm run custom-check", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "cd /work && npm run lint && npm run custom-check",
        exitCode: 0,
        outputSnippet: "ok",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a compound claim with a part recorded in a failing compound run still blocks (#2665)", () => {
  // The script's exit code is its FINAL statement's (#2326): per-part
  // matching must not launder that into a per-part pass.
  const mismatches = crossReferenceEvidence(
    [{ command: "bundle exec i18n-tasks missing", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "bundle exec rspec spec/requests && bundle exec i18n-tasks missing && grep -c LOCALE_KEY config/locales/en.yml",
        exitCode: 1,
        outputSnippet: "0",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /compound script/);
});

test("a compound claim with an unrecorded part falls back to whole-claim matching (#2665)", () => {
  // No part of this chain was ever executed and no recording contains it;
  // the claim must keep the plain "no matching call" warning instead of a
  // synthetic per-part verdict.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && ssh deploy@host restart", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run build",
        exitCode: 0,
        outputSnippet: "built",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /No bash tool call found/);
});

test("an exact newer whole-chain recording stays authoritative over older standalone history (#2665 codex)", () => {
  // Old standalone lint failure, then a successful exact recording of the
  // whole chain: the chain's own newest outcome is the evidence — per-part
  // matching must not resurrect the superseded standalone failure.
  const chain = "npm run lint && npm run typecheck";
  const mismatches = crossReferenceEvidence(
    [{ command: chain, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run lint",
        exitCode: 1,
        outputSnippet: "lint errors",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: chain,
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a newer failed whole-chain recording still blocks over older standalone passes (#2665 codex)", () => {
  const chain = "npm run lint && npm run typecheck";
  const mismatches = crossReferenceEvidence(
    [{ command: chain, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run lint",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm run typecheck",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
      {
        kind: "bash",
        toolCallId: "call-3",
        command: chain,
        exitCode: 1,
        outputSnippet: "typecheck errors",
        timestamp: 3,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
});

test("a chain with mixed operators keeps whole-claim matching (#2665 codex)", () => {
  // `||` short-circuits: per-part pass requirements would be wrong, so the
  // claim falls back to the pre-#2665 whole-claim behavior (substring match
  // against the recorded run, judged on its newest outcome).
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && npm test || true", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm test",
        exitCode: 1,
        outputSnippet: "test failure",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
});

test("a labeled whole-chain recording stays authoritative over older standalone history (#2665 codex r2)", () => {
  // The collector prefixes a gsd_exec label to recorded bodies; authority
  // detection must strip it before comparing to the claim.
  const chain = "npm run lint && npm run typecheck";
  const mismatches = crossReferenceEvidence(
    [{ command: chain, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run lint",
        exitCode: 1,
        outputSnippet: "lint errors",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: `gsd_exec bash: verify\n${chain}`,
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a claim carrying the collector label keeps whole-chain authority (#2665 codex r3)", () => {
  // Claims copied verbatim from persisted evidence carry the label too.
  const chain = "npm run lint && npm run typecheck";
  const mismatches = crossReferenceEvidence(
    [{ command: `gsd_exec bash: verify\n${chain}`, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run typecheck",
        exitCode: 1,
        outputSnippet: "older standalone failure",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: chain,
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a labeled claim with structured purpose text still gets whole-chain authority (#2665 codex r4)", () => {
  // The label purpose contains parens; the label must be stripped BEFORE
  // splitting so the failed whole-chain recording stays authoritative over
  // the newer standalone pass.
  const chain = "npm run lint && npm run typecheck";
  const mismatches = crossReferenceEvidence(
    [{ command: `gsd_exec bash: lint (then typecheck)\n${chain}`, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: chain,
        exitCode: 1,
        outputSnippet: "typecheck errors",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm run typecheck",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
});

test("cd-prefixed single commands keep wrapper-suffix comparison (#2665 codex r4)", () => {
  const base: BashEvidence[] = [
    {
      kind: "bash",
      toolCallId: "call-1",
      command: "cd /work",
      exitCode: 0,
      outputSnippet: "",
      timestamp: 1,
    },
    {
      kind: "bash",
      toolCallId: "call-2",
      command: "cd /work > out.log",
      exitCode: 1,
      outputSnippet: "",
      timestamp: 2,
    },
  ];
  // Newest redirect-suffixed failure is authoritative over the older exact
  // pass (baseline behavior; the suffix must still be peeled).
  const blocking = crossReferenceEvidence(
    [{ command: "cd /work", exitCode: 0, verdict: "passed" }],
    base,
  );
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].severity, "error");

  // Reversed outcomes stay clean.
  const reversed = base.map((call) => ({ ...call, exitCode: call.exitCode === 0 ? 1 : 0 }));
  const clean = crossReferenceEvidence(
    [{ command: "cd /work", exitCode: 0, verdict: "passed" }],
    reversed,
  );
  assert.deepEqual(clean, []);
});

test("a quoted cd path does not bypass whole-chain authority (#2665 codex r3)", () => {
  // The cd wrapper path contains a quoted `&&`: the chain's own failed
  // recording must not be shadowed by newer standalone successes.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && npm run typecheck", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: 'cd "/work/a && b" && npm run lint && npm run typecheck',
        exitCode: 1,
        outputSnippet: "typecheck errors",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm run typecheck",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
      {
        kind: "bash",
        toolCallId: "call-3",
        command: "npm run lint",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 3,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
});

test("a failed cd-wrapped chain recording stays authoritative over a newer standalone part pass (#2665 codex r2)", () => {
  const chain = "npm run lint && npm run typecheck";
  const mismatches = crossReferenceEvidence(
    [{ command: chain, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: `cd /work && ${chain}`,
        exitCode: 1,
        outputSnippet: "typecheck errors",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm run typecheck",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
});

test("splitTopLevelAnd splits only real top-level && chains (#2665)", () => {
  assert.deepEqual(splitTopLevelAnd("a && b"), ["a", "b"]);
  assert.deepEqual(splitTopLevelAnd("a && b && c"), ["a", "b", "c"]);
  assert.deepEqual(splitTopLevelAnd(" a &&  b "), ["a", "b"]);
  // Quoted segments are data: an && inside them must not split.
  assert.deepEqual(splitTopLevelAnd("grep 'a && b' file && npm test"), ["grep 'a && b' file", "npm test"]);
  assert.deepEqual(splitTopLevelAnd('echo "x && y"'), null);
  // Single commands, empty parts, unterminated quotes, and other operators or
  // grouping keep whole-claim matching.
  assert.equal(splitTopLevelAnd("npm test"), null);
  assert.equal(splitTopLevelAnd("a && "), null);
  assert.equal(splitTopLevelAnd("a && && b"), null);
  assert.equal(splitTopLevelAnd("echo 'unterminated && b"), null);
  assert.equal(splitTopLevelAnd("a || b"), null);
  assert.equal(splitTopLevelAnd("a; b"), null);
  assert.equal(splitTopLevelAnd("(a && b)"), null);
  assert.equal(splitTopLevelAnd("echo $(a && b) && c"), null);
  assert.equal(splitTopLevelAnd("a && b | tail -5"), null);
  // Newlines separate script statements: line-wise execution means a trailing
  // line can decide the outcome independently of the chain (#2665 codex r5).
  assert.equal(splitTopLevelAnd("lint && typecheck\nbuild"), null);
  // Command substitution inside double quotes executes too: keep whole-claim
  // matching instead of trusting quote toggling (#2665 codex r2).
  assert.equal(splitTopLevelAnd('echo "$(printf "%s" "a && b")" && npm test'), null);
  assert.equal(splitTopLevelAnd("echo `ls && pwd` && npm test"), null);
});

test("a multiline cd-prefixed script is not wrapper-equivalent to a line (#2665 codex r5)", () => {
  // `cd /work\nfalse && npm test` is two statements; the older exact pass of
  // the claimed line stays the newest evidence FOR that line and the newer
  // unrelated script must not shadow it (baseline behavior restored).
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm test",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "cd /work\nfalse && npm test",
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("a compound claim with SOME parts unrecorded falls back to whole-claim matching (#2665 codex)", () => {
  // `npm run lint` was recorded exactly, the tail never ran anywhere; per-part
  // judging is impossible, so the claim keeps the pre-#2665 whole-claim
  // behavior (substring match against the recorded run).
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run lint && ssh deploy@host restart", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run lint",
        exitCode: 0,
        outputSnippet: "clean",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});
