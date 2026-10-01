// Regression tests for #2317: on auto-mode resume, an enterMilestone failure
// caused by a stale git worktree registration must STOP execution (like
// lease-conflict) instead of degrading to project root and resuming onto the
// wrong tree. autoResumeEnterFailureStop is the decision the resume path in
// auto.ts consults.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { autoResumeEnterFailureStop } from "../auto/phase-helpers.ts";

describe("autoResumeEnterFailureStop (#2317)", () => {
  test("stops for lease-conflict with the established message", () => {
    const stop = autoResumeEnterFailureStop({ ok: false, reason: "lease-conflict" }, "M001");
    assert.ok(stop, "lease-conflict must stop the resume");
    assert.equal(stop.detail, "lease-conflict during resume");
    assert.equal(stop.notify, "Cannot resume milestone M001: lease is held by another worker.");
  });

  test("stops for stale-worktree-registration so auto never resumes onto the wrong tree", () => {
    const stop = autoResumeEnterFailureStop(
      { ok: false, reason: "stale-worktree-registration" },
      "M001",
    );
    assert.ok(stop, "stale worktree registration must stop the resume");
    assert.equal(stop.detail, "stale worktree registration during resume");
    assert.match(stop.notify, /Cannot resume milestone M001/);
    assert.match(stop.notify, /stale git worktree registration/);
    assert.match(stop.notify, /\/gsd auto/, "must tell the user how to resume after fixing");
  });

  test("returns null for ok and for degrade-tolerant failures", () => {
    assert.equal(autoResumeEnterFailureStop({ ok: true, mode: "worktree", path: "/x" }, "M001"), null);
    assert.equal(autoResumeEnterFailureStop({ ok: false, reason: "creation-failed" }, "M001"), null);
    assert.equal(autoResumeEnterFailureStop({ ok: false, reason: "isolation-degraded" }, "M001"), null);
    assert.equal(autoResumeEnterFailureStop({ ok: false, reason: "invalid-milestone-id" }, "M001"), null);
  });
});
