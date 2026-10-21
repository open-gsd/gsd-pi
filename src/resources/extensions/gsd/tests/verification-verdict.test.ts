// Project/App: gsd-pi
// File Purpose: Tests for host-owned auto-mode verification verdict policy.

import test from "node:test";
import assert from "node:assert/strict";

import { decideVerificationVerdict } from "../verification-verdict.ts";
import type { VerificationResult } from "../types.ts";

function makeResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    passed: true,
    checks: [],
    discoverySource: "none",
    timestamp: 1,
    ...overrides,
  };
}

test("execute-task fails closed when no host-owned checks are discovered", () => {
  const verdict = decideVerificationVerdict("execute-task", makeResult());

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "no-host-checks");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /No runnable host-owned verification command/);
  assert.match(verdict.failureContext, /\.gsd\/PREFERENCES\.md/);
  assert.match(verdict.failureContext, /\/gsd next/);
});

test("execute-task fails closed when every task-plan Verify command was shell-unsafe (issue #1922)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({ discoverySource: "task-plan-unsafe" }),
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "no-host-checks");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /Rewrite the Verify field/);
});

test("execute-task passes when non-runnable task-plan prose is the verification source", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({ discoverySource: "task-plan-prose" }),
  );

  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "passed");
  assert.equal(verdict.retryable, false);
});

test("non execute-task units preserve no-check pass semantics", () => {
  const verdict = decideVerificationVerdict("plan-slice", makeResult());

  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "passed");
});

test("execute-task command failure remains retryable verification failure", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "package-json",
      checks: [
        {
          command: "npm test",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          durationMs: 10,
        },
      ],
    }),
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "checks-failed");
  assert.equal(verdict.retryable, true);
});

test("missing verification command pauses for the operator instead of retrying the task (#1943)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "task-plan",
      checks: [{
        command: "grep -q expected app.css",
        exitCode: 1,
        stdout: "",
        stderr: "'grep' is not recognized as an internal or external command",
        durationMs: 10,
        failureClass: "command-not-found",
      }],
    }),
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "command-not-found");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /Verify command not runnable on this platform/);
  assert.match(verdict.failureContext, /grep -q expected app\.css/);
});

test("shell parse failure is a non-retryable execution fault", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "preference",
      checks: [
        {
          command: `node -e '"const'`,
          exitCode: 1,
          stdout: "",
          stderr: "[eval]:1\nUnterminated string constant\nSyntaxError: Invalid or unexpected token",
          durationMs: 10,
          failureClass: "shell-parse",
        },
      ],
    }),
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "execution-fault");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /shell could not parse/i);
  assert.match(verdict.failureContext, /node -e/);
});

test("blocking runtime errors provide failure context when host checks pass", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "package-json",
      checks: [
        {
          command: "npm test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 10,
        },
      ],
      runtimeErrors: [
        {
          source: "bg-shell",
          severity: "crash",
          message: "vite preview exited with code 143",
          blocking: true,
        },
        {
          source: "browser",
          severity: "warning",
          message: "non-blocking console warning",
          blocking: false,
        },
      ],
    }),
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "checks-failed");
  assert.equal(verdict.retryable, true);
  assert.equal(verdict.failureContext, "[bg-shell] vite preview exited with code 143");
});

test("execute-task passes when a discovered host check succeeds", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      discoverySource: "preference",
      checks: [
        {
          command: "npm test",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 10,
        },
      ],
    }),
  );

  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "passed");
});

test("command-not-found passes via qualifying task evidence when it is the only failure (#2209)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "task-plan",
      checks: [
        {
          command: `npx tsc --noEmit && ! grep -q "PLACEHOLDER" src/Footer.tsx`,
          exitCode: 127,
          stdout: "",
          stderr: "'grep' is not recognized as an internal or external command",
          durationMs: 10,
          failureClass: "command-not-found",
        },
      ],
    }),
    { hasQualifyingEvidence: true },
  );

  assert.equal(verdict.passed, true);
  assert.equal(verdict.reason, "passed-via-task-evidence");
  assert.equal(verdict.retryable, false);
});

test("command-not-found still pauses when task evidence is not qualifying (#2209)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "task-plan",
      checks: [{
        command: "grep -q expected app.css",
        exitCode: 127,
        stdout: "",
        stderr: "'grep' is not recognized as an internal or external command",
        durationMs: 10,
        failureClass: "command-not-found",
      }],
    }),
    { hasQualifyingEvidence: false },
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "command-not-found");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /Verify command not runnable on this platform/);
});

test("command-not-found without any task evidence keeps the existing pause (#2209)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "task-plan",
      checks: [{
        command: "grep -q expected app.css",
        exitCode: 127,
        stdout: "",
        stderr: "'grep' is not recognized as an internal or external command",
        durationMs: 10,
        failureClass: "command-not-found",
      }],
    }),
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "command-not-found");
  assert.equal(verdict.retryable, false);
});

test("a genuine failing check next to command-not-found cannot be laundered into a pass (#2209)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "task-plan",
      checks: [
        {
          command: "! grep -q PLACEHOLDER src/Footer.tsx",
          exitCode: 127,
          stdout: "",
          stderr: "'grep' is not recognized as an internal or external command",
          durationMs: 10,
          failureClass: "command-not-found",
        },
        {
          command: "npm test",
          exitCode: 1,
          stdout: "",
          stderr: "2 tests failed",
          durationMs: 10,
        },
      ],
    }),
    { hasQualifyingEvidence: true },
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "command-not-found");
  assert.equal(verdict.retryable, false);
});

test("a blocking runtime error next to command-not-found cannot be laundered into a pass (#2209)", () => {
  const verdict = decideVerificationVerdict(
    "execute-task",
    makeResult({
      passed: false,
      discoverySource: "task-plan",
      checks: [
        {
          command: "! grep -q PLACEHOLDER src/Footer.tsx",
          exitCode: 127,
          stdout: "",
          stderr: "'grep' is not recognized as an internal or external command",
          durationMs: 10,
          failureClass: "command-not-found",
        },
      ],
      runtimeErrors: [
        {
          source: "bg-shell",
          severity: "crash",
          message: "vite preview exited with code 143",
          blocking: true,
        },
      ],
    }),
    { hasQualifyingEvidence: true },
  );

  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, "command-not-found");
  assert.equal(verdict.retryable, false);
  assert.match(verdict.failureContext, /Verify command not runnable on this platform/);
});
