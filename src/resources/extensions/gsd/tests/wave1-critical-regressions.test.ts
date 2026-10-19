// GSD State Machine — Wave 1 Critical Regression Tests
// Validates fixes for skipped milestone status,
// dead code removal, and replan disk-file fallback.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isClosedStatus } from "../status-guards.js";

// ── Fix 3: getActiveMilestoneId must skip "skipped" milestones ──

describe("isClosedStatus includes skipped", () => {
  test("complete is closed", () => assert.ok(isClosedStatus("complete")));
  test("done is closed", () => assert.ok(isClosedStatus("done")));
  test("skipped is closed", () => assert.ok(isClosedStatus("skipped")));
  test("pending is not closed", () => assert.ok(!isClosedStatus("pending")));
  test("active is not closed", () => assert.ok(!isClosedStatus("active")));
});
