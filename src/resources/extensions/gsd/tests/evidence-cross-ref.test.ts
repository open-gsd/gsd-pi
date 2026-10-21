// Project/App: gsd-pi
// File Purpose: Tests for verification evidence cross-reference mismatch policy.

import test from "node:test";
import assert from "node:assert/strict";

import { crossReferenceEvidence } from "../safety/evidence-cross-ref.ts";
import type { EvidenceEntry } from "../safety/evidence-collector.ts";
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
