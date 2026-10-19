/**
 * pre-exec-gate-loop.test.ts — Regression tests for #4551.
 *
 * Verifies the failure context that a failed pre-execution gate gives the
 * planner retry: the real findings come first, and Verify-command guidance is
 * added only for unsafe or non-runnable Verify commands.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatPreExecutionRetryContext } from "../auto-post-unit.ts";

// ─── Tests ────────────────────────────────────────────────────────────────────

test("pre-exec retry context leads with the real findings and only adds Verify guidance for unsafe Verify commands", () => {
  const artifactCheck = {
    category: "file" as const,
    target: ".gsd/phases/01-answer-fixture/01-03-ASSESSMENT.md",
    passed: false,
    message: "Task T03 lists '.gsd/phases/01-answer-fixture/01-03-ASSESSMENT.md' in expectedOutput — GSD planning artifacts are written by workflow tools (e.g. gsd_summary_save), never by tasks; remove it",
    blocking: true,
  };
  const base = {
    unitType: "plan-slice",
    unitId: "M001/S04",
    verdictExcerpt: "status=fail; 1 blocking issue detected",
    evidencePath: ".gsd/phases/01-answer-fixture/S04-PRE-EXEC-VERIFY.json",
  };

  const artifactContext = formatPreExecutionRetryContext({ ...base, checks: [artifactCheck] });
  // The liveness backstop excerpts the first 300 chars of this text as the
  // wedge's sanctioned exit, so the real blocker must come first.
  assert.ok(artifactContext.slice(0, 300).includes("01-03-ASSESSMENT.md' in expectedOutput"));
  assert.ok(!artifactContext.includes("Verify commands must not use shell pipes"));
  assert.ok(!artifactContext.includes("known runnable command"));
  assert.ok(!artifactContext.includes("reads as prose"));

  const verifyContext = formatPreExecutionRetryContext({
    ...base,
    checks: [{
      category: "tool",
      target: "T01 Verify",
      passed: false,
      message: "Unsafe or non-runnable Verify command: cat a | grep b (pipes are not allowed)",
      blocking: true,
    }],
  });
  assert.ok(verifyContext.includes("Unsafe or non-runnable Verify command"));
  assert.ok(verifyContext.includes("Verify commands must not use shell pipes"));
});

test("pre-exec retry guidance for non-runnable rejections states the known-prefix and prose-marker rules", () => {
  // Mirrors the real message format from pre-execution-checks.ts:
  // `Unsafe or non-runnable Verify command: ${command} (${validation.reason})`.
  // A prose-pattern statement is rejected with the "does not look like a
  // runnable command" reason (#2290) — the guidance must state the two rules
  // behind that reason so the repaired plan stops repeating the pattern.
  const context = formatPreExecutionRetryContext({
    unitType: "plan-slice",
    unitId: "M001/S04",
    verdictExcerpt: "status=fail; 1 blocking issue detected",
    evidencePath: ".gsd/phases/01-answer-fixture/S04-PRE-EXEC-VERIFY.json",
    checks: [{
      category: "tool",
      target: "T01 Verify",
      passed: false,
      blocking: true,
      message: "Unsafe or non-runnable Verify command: Verify the scaffold output contains the summary (does not look like a runnable command)",
    }],
  });

  const reason = "does not look like a runnable command";
  assert.ok(context.includes(reason), "finding must be echoed");
  // The finding line already contains the reason once; the guidance must
  // restate it so the planner can connect message → rule.
  assert.ok(
    context.split(reason).length >= 3,
    "guidance must restate the rejection reason, not just echo the finding",
  );
  // Known-command-prefix rule, with the illustrative-list, path-prefix, and
  // short-statement fallback qualifications.
  assert.ok(
    context.includes("known runnable command such as"),
    "guidance must state the known-command-prefix rule",
  );
  assert.ok(context.includes("illustrative, not exhaustive"));
  assert.ok(
    context.includes("same prose checks as a known command"),
    "path prefix must not be presented as a prose-check escape",
  );
  assert.ok(context.includes("may pass without a known prefix"));
  // Prose-marker rule: marker matching runs on unquoted text only (#2290),
  // quoted words still count toward the word minimum; the plain-word tail
  // rule ignores trailing punctuation but any shell-like token breaks it.
  assert.ok(
    context.includes("reads as prose"),
    "guidance must state the prose-marker rule",
  );
  assert.ok(
    context.includes("unquoted word"),
    "guidance must state that marker words only count when unquoted",
  );
  assert.ok(context.includes("never match markers"));
  assert.ok(context.includes("count toward the word minimum"));
  assert.ok(context.includes("trailing punctuation ignored"));
  assert.ok(context.includes("breaks the run"));
});
