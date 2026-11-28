// Project/App: gsd-pi
// File Purpose: Regression tests for #3199 — a turn-abort harness abort recorded
// before a provider-model fallback switch must be cleared once the recovered
// turn executes exec tools successfully, so the following gate saves
// (save_uat_result, save_gate_result, hook_verdict_save) are not rejected.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  clearUnitHarnessAbort,
  readUnitHarnessAbort,
  recordUnitHarnessAbort,
} from "../unit-runtime.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_PATH = join(__dirname, "..", "bootstrap", "register-hooks.ts");

// ── Behavioral: the clear must accept the turn-abort kind (#3199) ────────────

test("clearUnitHarnessAbort with expectedKind turn-abort clears a recorded turn-abort", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-turn-abort-clear-"));
  const startedAt = Date.now();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    recordUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt, {
      kind: "turn-abort",
      reason:
        "Agent turn aborted before the unit could complete its gate evaluation. origin=error stopReason=error error=You've hit your weekly limit",
    });
    assert.equal(
      readUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt)?.kind,
      "turn-abort",
      "test setup should start with a turn-abort marker",
    );

    clearUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt, "turn-abort");

    assert.equal(
      readUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt),
      null,
      "gate saves must no longer be blocked once the recovered turn is executing tools",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("clearUnitHarnessAbort with expectedKind tool-error does not clear a turn-abort (pre-#3199 behavior)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-turn-abort-clear-"));
  const startedAt = Date.now();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    recordUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt, {
      kind: "turn-abort",
      reason: "Agent turn aborted before the unit could complete its gate evaluation.",
    });

    // This is what the successful-exec path did before the fix: it only
    // cleared the tool-error kind, so a turn-abort survived the fallback
    // switch and blocked gsd_uat_result_save.
    clearUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt, "tool-error");

    assert.equal(
      readUnitHarnessAbort(base, "run-uat", "M008/S03", startedAt)?.kind,
      "turn-abort",
      "a tool-error-kind clear must not remove a turn-abort marker",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Structural: the successful-exec clearing must cover turn-abort (#3199) ───

test("successful gsd_exec/gsd_uat_exec clearing covers tool-error and turn-abort kinds", () => {
  const src = readFileSync(HOOKS_PATH, "utf-8");

  // The helper called on exec success must clear both kinds for the current
  // unit run. Before the fix it only passed "tool-error".
  const helperRe =
    /function clearCurrentUnitRecoveredHarnessAbort\(toolName: string\): void \{[\s\S]*?for \(const kind of \["tool-error", "turn-abort"\] as const\) \{[\s\S]*?clearUnitHarnessAbort\(/;
  assert.ok(
    helperRe.test(src),
    "the exec-success clearing helper must clear both tool-error and turn-abort harness aborts (#3199)",
  );

  // Both tool_execution_end handlers must still route exec success through it.
  const callCount = src.split("clearCurrentUnitRecoveredHarnessAbort(toolName)").length - 1;
  assert.equal(
    callCount,
    2,
    "both tool_execution_end handlers must call the clearing helper on exec success",
  );

  // The stale helper name must be gone.
  assert.ok(
    !src.includes("clearCurrentUnitToolErrorHarnessAbort"),
    "the old tool-error-only helper name must not remain",
  );
});
