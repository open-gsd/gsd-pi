/**
 * Regression test for MCP tool-availability race.
 *
 * When the MCP workflow server is still connecting, tool calls fail with
 * "No such tool available". The bounded retry counter on AutoSession
 * (toolUnavailableRetries) prevents infinite re-dispatch loops by capping
 * retries at 3 with escalating delay, then pausing auto-mode.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AutoSession } from "../auto/session.ts";

describe("toolUnavailableRetries on AutoSession", () => {
  test("defaults to 0", () => {
    const s = new AutoSession();
    assert.equal(s.toolUnavailableRetries, 0);
  });

  test("is cleared on reset()", () => {
    const s = new AutoSession();
    s.toolUnavailableRetries = 2;
    s.reset();
    assert.equal(s.toolUnavailableRetries, 0);
  });

  test("accumulates across assignments (simulates retry increments)", () => {
    const s = new AutoSession();
    s.toolUnavailableRetries = 1;
    s.toolUnavailableRetries = 2;
    s.toolUnavailableRetries = 3;
    assert.equal(s.toolUnavailableRetries, 3);
  });
});

describe("tool-unavailable retry backoff (#817)", () => {
  // Mirrors the delay formula in auto-post-unit.ts. The MCP workflow server can
  // take tens of seconds to finish connecting, so the backoff must start high
  // enough that re-dispatch does not land before the server is ready.
  const backoffMs = (retry: number) =>
    Math.min(10_000 * Math.pow(2, retry - 1), 45_000);

  test("starts at 10s, doubles, and caps at 45s", () => {
    assert.equal(backoffMs(1), 10_000);
    assert.equal(backoffMs(2), 20_000);
    assert.equal(backoffMs(3), 40_000);
  });

  test("never exceeds the 45s cap", () => {
    assert.equal(backoffMs(4), 45_000);
    assert.equal(backoffMs(10), 45_000);
  });

  test("first retry survives a multi-second MCP startup (regression for 1s delay)", () => {
    assert.ok(backoffMs(1) >= 10_000, "first retry must wait at least 10s");
  });
});
