// Project/App: gsd-pi
// File Purpose: Regression tests for evidence cross-referencing of gsd_exec /
// gsd_uat_exec tool calls. Mirrors the live false-positive where an
// execute-task agent ran its verification commands through gsd_exec (script
// body in the `script` argument) and the cross-referencer reported
// "No bash tool call found" despite successful execution.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resetEvidence,
  getEvidence,
  recordToolCall,
  recordToolResult,
  isExecutionToolName,
  type BashEvidence,
} from "../safety/evidence-collector.ts";
import { crossReferenceEvidence } from "../safety/evidence-cross-ref.ts";

function gsdExecResult(exitCode: number, id = "4858202d-2ed7-4a0a-9ef7-4e159e65da83"): unknown {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        operation: "gsd_exec",
        id,
        runtime: "bash",
        exit_code: exitCode,
        signal: null,
        timed_out: false,
        duration_ms: 272,
        stdout_bytes: 592,
        stderr_bytes: 0,
        meta_path: `/tmp/does-not-exist/.gsd/exec/${id}.meta.json`,
      }),
    }],
  };
}

test("evidence-xref: verification run through gsd_exec script matches the claimed command", () => {
  resetEvidence();

  // The live false positive: agent runs `node --test tests/verify-s01.test.js`
  // inside a gsd_exec script with a cd prefix and exit-code echo suffix.
  recordToolCall("tc-exec-1", "gsd_exec", {
    script: 'cd /work/.gsd/worktrees/M001 && node --test tests/verify-s01.test.js; echo "EXIT=$?"',
    purpose: "T02: run node --test contract checks against T01 index.html",
  });
  recordToolResult("tc-exec-1", "gsd_exec", gsdExecResult(0), false);

  const mismatches = crossReferenceEvidence(
    [{ command: "node --test tests/verify-s01.test.js", exitCode: 0, verdict: "passed" }],
    getEvidence(),
  );

  assert.deepEqual(mismatches, [], "gsd_exec-executed verification must not be flagged as missing");
});

test("evidence-xref: gsd_exec runtime-purpose label matches the recorded sandbox run", () => {
  resetEvidence();

  recordToolCall("tc-exec-label", "gsd_exec", {
    runtime: "node",
    code: "const plan = 'T02-PLAN'; if (!plan.includes('T02')) process.exit(1);",
    purpose: "validate T02-PLAN contains canonical Cargo command, state seam, d",
  });
  recordToolResult("tc-exec-label", "gsd_exec", gsdExecResult(0), false);

  const mismatches = crossReferenceEvidence(
    [{
      command: "gsd_exec node: validate T02-PLAN contains canonical Cargo command, state seam, d",
      exitCode: 0,
      verdict: "passed",
    }],
    getEvidence(),
  );

  assert.deepEqual(mismatches, [], "gsd_exec purpose labels must match sandbox evidence");
});

test("evidence-xref: multi-line gsd_exec script matches claims for each embedded command", () => {
  resetEvidence();

  recordToolCall("tc-exec-2", "gsd_exec", {
    script: [
      "cd /work/.gsd/worktrees/M001",
      "sed -i '' \"s/'todos'/'tasks-v1'/\" index.html",
      "node --test tests/verify-s01.test.js > /dev/null 2>&1",
      'echo "BROKEN_EXIT=$?"',
    ].join("\n"),
    purpose: "T02: deliberate contract break must fail, then restore",
  });
  recordToolResult("tc-exec-2", "gsd_exec", gsdExecResult(0), false);

  const mismatches = crossReferenceEvidence(
    [{ command: "node --test tests/verify-s01.test.js > /dev/null 2>&1", exitCode: 0, verdict: "passed" }],
    getEvidence(),
  );

  assert.deepEqual(mismatches, [], "command embedded in a multi-line script must match");
});

test("evidence-xref: claimed pass with failing gsd_exec exit_code is still an error", () => {
  resetEvidence();

  recordToolCall("tc-exec-3", "gsd_exec", {
    script: "node --test tests/verify-s01.test.js",
    purpose: "verification",
  });
  // gsd_exec reports failures via the JSON envelope's exit_code (and isError).
  recordToolResult("tc-exec-3", "gsd_exec", gsdExecResult(1), true);

  const mismatches = crossReferenceEvidence(
    [{ command: "node --test tests/verify-s01.test.js", exitCode: 0, verdict: "passed" }],
    getEvidence(),
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0 but actual exitCode=1/);
});

test("evidence-collector: gsd_uat_exec and MCP-namespaced variants are execution tools", () => {
  assert.equal(isExecutionToolName("gsd_uat_exec"), true);
  assert.equal(isExecutionToolName("mcp__gsd-workflow__gsd_uat_exec"), true);
  assert.equal(isExecutionToolName("mcp__gsd-workflow__gsd_exec"), true);

  resetEvidence();
  recordToolCall("tc-uat-1", "gsd_uat_exec", { script: "curl -fsS http://localhost:3000/health" });
  const bash = getEvidence().filter((e): e is BashEvidence => e.kind === "bash");
  assert.equal(bash.length, 1, "gsd_uat_exec must record bash evidence");
  assert.equal(bash[0].command, "curl -fsS http://localhost:3000/health");
});

test("evidence-xref: blank-command evidence does not satisfy arbitrary claims", () => {
  // Before script extraction existed, gsd_exec calls were recorded with
  // command: "" — and `"x".includes("")` made them match every claim,
  // masking genuine fabrications. Blank entries must never match.
  const mismatches = crossReferenceEvidence(
    [{ command: "node --test tests/verify-s01.test.js", exitCode: 0, verdict: "passed" }],
    [{
      kind: "bash",
      toolCallId: "tc-blank",
      command: "",
      exitCode: 0,
      outputSnippet: "",
      timestamp: 1,
    }],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /No bash tool call found/);
});

test("evidence-collector: exit code falls back to .gsd/exec meta.json when result text omits it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-exec-meta-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const metaPath = join(dir, "run-1.meta.json");
  writeFileSync(metaPath, JSON.stringify({ id: "run-1", exit_code: 7 }));

  resetEvidence();
  recordToolCall("tc-meta-1", "gsd_exec", { script: "exit 7" });
  // Truncated result: meta_path survives but exit_code was cut off.
  recordToolResult(
    "tc-meta-1",
    "gsd_exec",
    { content: [{ type: "text", text: `{"operation":"gsd_exec","meta_path":${JSON.stringify(metaPath)}` }] },
    false,
  );

  const bash = getEvidence().filter((e): e is BashEvidence => e.kind === "bash");
  assert.equal(bash[0].exitCode, 7, "exit code must be recovered from meta.json");
});
