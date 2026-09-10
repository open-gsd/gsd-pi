// Project/App: gsd-pi
// File Purpose: Guard that auto-loop break branches record the real break reason (not a hardcoded "unit-break") in the dispatch ledger.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LOOP_SOURCE = readFileSync(fileURLToPath(new URL("../auto/loop.ts", import.meta.url)), "utf8");

test("loop break branches settle the ledger with the resolved break reason", () => {
  const branches = LOOP_SOURCE.split('unitPhaseResult.action === "break"').slice(1);
  assert.ok(branches.length >= 2, "expected at least the legacy and custom-engine break branches");

  for (const branch of branches) {
    const sentinel = branch.search(/\n\s*break;/);
    assert.notEqual(sentinel, -1, "expected a `break;` sentinel to terminate the break branch body");
    const body = branch.slice(0, sentinel);
    assert.match(body, /const breakReason = unitPhaseResult\.reason \?\? "unit-break";/);
    // The optional third argument is the structured ledger exit_reason (#2218,
    // e.g. "timeout" for mid-unit timeout kills) — derived from the same
    // resolved breakReason, never hardcoded.
    assert.match(body, /closeRun\("failed", breakReason(, exitReasonForBreak\(breakReason\))?\)/);
    // The trailing argument is the ADR-047 liveness guard id — a stable guard
    // identity, deliberately constant so repeat blocks hash to one signature.
    // It is not the break reason, which must stay the resolved reason.
    assert.match(body, /finishTurn\("stopped", "execution", breakReason, "unit-break"\)/);
    const withoutGuardIdentities = body
      .replace(/const breakReason = unitPhaseResult\.reason \?\? "unit-break";/, "")
      .replace(/finishTurn\("stopped", "execution", breakReason, "unit-break"\)/, "");
    assert.doesNotMatch(
      withoutGuardIdentities,
      /"unit-break"/,
      "break reason must not be hardcoded — distinct reasons must stay distinct for stuck-loop detection",
    );
  }
});
