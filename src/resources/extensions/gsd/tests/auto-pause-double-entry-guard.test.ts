// Regression tests for #6309: double-pause race in pauseAuto causes spurious
// "Paused by user request" detail when a concurrent or overlapping pauseAuto
// call runs the full pause body a second time.
//
// Fix: s.active is set to false immediately after the re-entry guard, before any
// async I/O, so a concurrent call hits the guard and returns early.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capturePauseAutoUnitIdentity, pauseAuto, isAutoActive } from "../auto.ts";
import { _resetPendingResolve, _setCurrentResolve } from "../auto/resolve.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { _isPauseOriginCancelledResult } from "../auto/phase-helpers.ts";
import { handleAutoCommand } from "../commands/handlers/auto.ts";

test("pauseAuto sets s.active = false synchronously before first await (blocks concurrent re-entry)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-double-pause-guard-"));
  const previousCwd = process.cwd();

  autoSession.reset();
  autoSession.active = true;

  try {
    process.chdir(base);

    // Start pauseAuto but do not await — the synchronous preamble runs immediately.
    // s.active = false is set before the first await in pauseAuto, so isAutoActive()
    // must already be false at this point. In the old code it was only set at the very
    // end of the async chain, leaving the door open for a second concurrent call to
    // pass the guard and execute the full pause body.
    const firstPause = pauseAuto();

    assert.equal(
      isAutoActive(),
      false,
      "s.active must be false before the first await so concurrent callers cannot re-enter",
    );

    // A concurrent second call must see s.active = false and return immediately.
    // If the old code were in place this would run the full pause body a second time,
    // overwriting the lifecycle outcome with "Paused by user request."
    const secondPause = pauseAuto();

    await Promise.all([firstPause, secondPause].map((p) => p.catch(() => {})));

    assert.equal(autoSession.paused, true);
    assert.equal(isAutoActive(), false);
  } finally {
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("pauseAuto marks paused and cancels the in-flight unit before first await", async () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.currentUnit = {
    type: "execute-task",
    id: "M001/S01/T01",
    startedAt: 500,
  };
  let cancelledResult: unknown;
  _setCurrentResolve((result) => {
    cancelledResult = result;
  });

  try {
    const pausePromise = pauseAuto();

    assert.equal(autoSession.paused, true);
    assert.deepEqual(cancelledResult, { status: "cancelled" });

    await pausePromise.catch(() => {});
  } finally {
    _resetPendingResolve();
    autoSession.reset();
  }
});

test("/gsd pause aborts the active pi turn before first await", async () => {
  autoSession.reset();
  autoSession.active = true;
  let abortCount = 0;
  const ctx = {
    hasUI: false,
    isIdle: () => false,
    abort: () => {
      abortCount += 1;
    },
    sessionManager: {
      getSessionFile: () => null,
    },
    ui: {
      setStatus() {},
      setWidget() {},
      notify() {},
    },
  } as any;

  try {
    const pausePromise = handleAutoCommand("pause", ctx, {} as any);

    assert.equal(
      abortCount,
      1,
      "pauseAuto must abort the active pi turn before reporting auto-mode paused",
    );

    await pausePromise.catch(() => {});
  } finally {
    autoSession.reset();
  }
});

test("transient-abort errorContext is not classified as pause-origin cancellation", () => {
  // The phases.ts fix passes unitResult.errorContext to pauseAuto for transient aborts.
  // _isPauseOriginCancelledResult must return false when errorContext is present, ensuring
  // the lifecycle outcome detail comes from the error context rather than falling through
  // to the generic "Paused by user request." string.
  assert.equal(
    _isPauseOriginCancelledResult(true, undefined),
    true,
    "paused with no errorContext = user-initiated pause (pause-origin)",
  );
  assert.equal(
    _isPauseOriginCancelledResult(true, { category: "aborted", message: "provider aborted request" }),
    false,
    "paused with errorContext = transient abort, must not be treated as pause-origin",
  );
  assert.equal(
    _isPauseOriginCancelledResult(false, undefined),
    false,
    "not paused = not pause-origin regardless of errorContext",
  );
});

test("pauseAuto ignores stale pre-dispatch pause once a new unit is active", async () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.currentUnit = {
    type: "research-slice",
    id: "M011/S05",
    startedAt: 500,
  };

  try {
    await pauseAuto(undefined, undefined, undefined, { expectedCurrentUnit: null });

    assert.equal(autoSession.active, true);
    assert.equal(autoSession.paused, false);
    assert.deepEqual(autoSession.currentUnit, {
      type: "research-slice",
      id: "M011/S05",
      startedAt: 500,
    });
  } finally {
    autoSession.reset();
  }
});

test("pauseAuto ignores stale pause for a superseded unit identity", async () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.currentUnit = {
    type: "research-slice",
    id: "M011/S05",
    startedAt: 500,
  };

  try {
    await pauseAuto(undefined, undefined, undefined, {
      expectedCurrentUnit: {
        type: "plan-slice",
        id: "M011/S04",
        startedAt: 100,
      },
    });

    assert.equal(autoSession.active, true);
    assert.equal(autoSession.paused, false);
    assert.deepEqual(autoSession.currentUnit, {
      type: "research-slice",
      id: "M011/S05",
      startedAt: 500,
    });
  } finally {
    autoSession.reset();
  }
});

test("pauseAuto still pauses when the expected unit identity matches", async () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.currentUnit = {
    type: "research-slice",
    id: "M011/S05",
    startedAt: 500,
  };
  const expectedCurrentUnit = capturePauseAutoUnitIdentity();

  try {
    await pauseAuto(undefined, undefined, undefined, { expectedCurrentUnit });

    assert.equal(autoSession.active, false);
    assert.equal(autoSession.paused, true);
  } finally {
    autoSession.reset();
  }
});
