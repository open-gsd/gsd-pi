import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The latch (#2355) must be observable with the addon genuinely loaded, so the
// fault injection patches the loaded native record's ProjectionRootIdentityLock
// constructor instead of suppressing the load. Each scenario runs in a fresh
// subprocess because the latch is module state.
function runLatchScenario(script) {
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: packageRoot,
    // GSD_NATIVE_DISABLE is force-cleared: the latch can only be exercised
    // when a real addon record loaded (isNativeAddonLoaded() true).
    env: { ...process.env, GSD_NATIVE_DISABLE: "", GSD_NATIVE_PREFER_LOCAL: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const patchHelper = `
  const { native, isNativeAddonLoaded } = require("./dist/native");
  const { acquireProjectionRootIdentityLock, isProjectionRootIdentityLockAvailable } = require("./dist/file-identity");
  const attemptAcquire = () => {
    try {
      acquireProjectionRootIdentityLock("/tmp/gsd-latch-probe", "0", "0");
      return null;
    } catch (error) {
      return error.message;
    }
  };
`;

test("latch reports the native lock unhealthy after repeated transient failures, degrading gated paths to plain-fs", () => {
  const output = runLatchScenario(`${patchHelper}
    let constructions = 0;
    native.ProjectionRootIdentityLock = class {
      constructor() {
        constructions += 1;
        throw new Error("projection root operation failed: C:\\\\repo: The process cannot access the file because it is being used by another process. (os error 32)");
      }
    };
    const attempts = [];
    for (let i = 1; i <= 3; i++) {
      attempts.push({ attempt: i, error: attemptAcquire(), available: isProjectionRootIdentityLockAvailable() });
    }
    // While latched, the gate must read unavailable and the failing native
    // constructor must stop being invoked — that gate flip is exactly what
    // sends the extension's projection paths to their plain-fs fallbacks.
    const afterLatch = { error: attemptAcquire(), available: isProjectionRootIdentityLockAvailable() };
    process.stdout.write(JSON.stringify({ loaded: isNativeAddonLoaded(), attempts, afterLatch, constructions }));
  `);

  assert.equal(output.loaded, true, "native addon did not load — run `pnpm run build:native:dev` first");
  assert.equal(output.constructions, 3, "latched gate must stop invoking the failing native constructor");
  assert.match(output.attempts[0].error, /locking failed/);
  assert.equal(output.attempts[0].available, true, "first failure must not latch");
  assert.match(output.attempts[1].error, /locking failed/);
  assert.equal(output.attempts[1].available, true, "second failure must not latch");
  assert.match(output.attempts[2].error, /locking failed/);
  assert.equal(output.attempts[2].available, false, "third consecutive transient failure latches");
  assert.equal(output.afterLatch.available, false, "gate must report unavailable while latched (fallback engage)");
  assert.equal(output.afterLatch.error, "native projection root identity locking is unavailable");
});

test("the reported repro shape latches: successful prepares interleaved with failing publishes must not reset the counter", () => {
  const output = runLatchScenario(`${patchHelper}
    // #2355's deterministic Windows shape: preparation (create/write/fsync)
    // succeeds, publication (reopen/identity check/rename) fails with a
    // sharing violation every time.
    let publishes = 0;
    native.ProjectionRootIdentityLock = class {
      constructor() {}
      prepareFileTemporary() {
        return "staged-identity";
      }
      publishFileTemporary() {
        publishes += 1;
        throw new Error("projection root operation failed: C:\\\\repo: sharing violation (os error 32)");
      }
      pathExists() {
        return true;
      }
    };
    const handle = acquireProjectionRootIdentityLock("/tmp/gsd-latch-probe", "0", "0");
    const outcomes = [];
    for (let i = 1; i <= 3; i++) {
      try {
        handle.prepareFileTemporary("a", Buffer.alloc(0));
        handle.publishFileTemporary("a", "b", "id");
      } catch {
        // Expected transient publication failure.
      }
      outcomes.push({ publish: i, available: isProjectionRootIdentityLockAvailable() });
    }
    process.stdout.write(JSON.stringify({ outcomes, publishes, finalAvailable: isProjectionRootIdentityLockAvailable() }));
  `);

  assert.equal(output.publishes, 3, "latched gate must stop feeding the failing publication path");
  assert.equal(output.outcomes[0].available, true, "first publication failure must not latch");
  assert.equal(output.outcomes[1].available, true, "second publication failure must not latch");
  assert.equal(output.outcomes[2].available, false, "interleaved prepare successes must not keep the latch open");
  assert.equal(output.finalAvailable, false);
});

test("recovery requires the previously failing operation itself to succeed", () => {
  const output = runLatchScenario(`${patchHelper}
    let publishShouldFail = true;
    native.ProjectionRootIdentityLock = class {
      constructor() {}
      prepareFileTemporary() {
        return "staged-identity";
      }
      publishFileTemporary() {
        if (publishShouldFail) {
          throw new Error("projection root operation failed: busy (os error 32)");
        }
      }
      pathExists() {
        return true;
      }
    };
    const handle = acquireProjectionRootIdentityLock("/tmp/gsd-latch-probe", "0", "0");
    const fail = () => {
      try {
        handle.publishFileTemporary("a", "b", "id");
      } catch {
        // Expected transient failure.
      }
    };
    fail();
    fail();
    // An unrelated operation succeeding must not clear the counter.
    handle.pathExists("");
    // The previously failing operation succeeding clears the counter.
    publishShouldFail = false;
    handle.publishFileTemporary("a", "b", "id");
    publishShouldFail = true;
    fail();
    fail();
    const stillAvailable = isProjectionRootIdentityLockAvailable();
    fail();
    process.stdout.write(JSON.stringify({ stillAvailable, latchedAgain: isProjectionRootIdentityLockAvailable() }));
  `);

  assert.equal(output.stillAvailable, true, "recovery of the failing op must reset the counter");
  assert.equal(output.latchedAgain, false);
});

test("close() after a failing operation neither masks the failure nor counts as recovery", () => {
  const output = runLatchScenario(`${patchHelper}
    native.ProjectionRootIdentityLock = class {
      constructor() {}
      writeFile() {
        throw new Error("projection root operation failed: sharing violation (os error 32)");
      }
      close() {}
    };
    const handle = acquireProjectionRootIdentityLock("/tmp/gsd-latch-probe", "0", "0");
    const fail = () => {
      try {
        handle.writeFile("a", Buffer.alloc(0));
      } catch {
        // Expected transient failure.
      }
      handle.close();
    };
    fail();
    fail();
    fail();
    process.stdout.write(JSON.stringify({ latched: isProjectionRootIdentityLockAvailable() }));
  `);

  assert.equal(output.latched, false, "close() in a finally block must not reset the latch");
});

test("non-transient failures never latch (fail-closed semantics preserved)", () => {
  const output = runLatchScenario(`${patchHelper}
    let constructions = 0;
    native.ProjectionRootIdentityLock = class {
      constructor() {
        constructions += 1;
        throw new Error("projection root operation failed: access denied (os error 5)");
      }
    };
    const errors = [];
    for (let i = 0; i < 5; i++) errors.push(attemptAcquire());
    process.stdout.write(JSON.stringify({ errors, available: isProjectionRootIdentityLockAvailable(), constructions }));
  `);

  assert.equal(output.constructions, 5, "non-transient failures must keep reaching the native layer");
  assert.equal(output.available, true, "non-transient family must not feed the latch");
  for (const error of output.errors) assert.match(error, /locking failed/);
});

test("transient classification rejects pathname text and accepts errno codes and wrapped causes", () => {
  const output = runLatchScenario(`${patchHelper}
    const { _resetProjectionRootIdentityLockHealthForTest } = require("./dist/file-identity");
    let mode = "none";
    native.ProjectionRootIdentityLock = class {
      constructor() {
        if (mode === "pathname-ebusy") {
          throw new Error("projection root operation failed: C:\\\\EBUSY\\\\repo: Access is denied. (os error 5)");
        }
        if (mode === "ebusy-code") {
          throw Object.assign(new Error("lock contentention"), { code: "EBUSY" });
        }
        if (mode === "wrapped") {
          throw new Error("journal replay aborted", {
            cause: new Error("projection root operation failed: projection root is busy"),
          });
        }
      }
    };
    // A directory literally named EBUSY inside the message path must not
    // classify as transient — only diagnostic text after the last ": " may.
    mode = "pathname-ebusy";
    for (let i = 0; i < 5; i++) attemptAcquire();
    const pathnameAvailable = isProjectionRootIdentityLockAvailable();
    _resetProjectionRootIdentityLockHealthForTest();
    // EBUSY errno codes classify without message text.
    mode = "ebusy-code";
    attemptAcquire();
    attemptAcquire();
    attemptAcquire();
    const ebusyLatched = isProjectionRootIdentityLockAvailable();
    _resetProjectionRootIdentityLockHealthForTest();
    // A transient wrapped in a cause chain classifies like a bare one.
    mode = "wrapped";
    attemptAcquire();
    attemptAcquire();
    attemptAcquire();
    const wrappedLatched = isProjectionRootIdentityLockAvailable();
    process.stdout.write(JSON.stringify({ pathnameAvailable, ebusyLatched, wrappedLatched }));
  `);

  assert.equal(output.pathnameAvailable, true, "pathname text must never feed the latch");
  assert.equal(output.ebusyLatched, false, "EBUSY errno codes feed the latch");
  assert.equal(output.wrappedLatched, false, "cause-chain transients feed the latch");
});

test("latch re-probes after the cool-off, honors the boundary exactly, and re-latches on the next transient failure", () => {
  const output = runLatchScenario(`${patchHelper}
    const { _setProjectionRootIdentityLockClockForTest } = require("./dist/file-identity");
    let now = 1_000_000;
    _setProjectionRootIdentityLockClockForTest(() => now);
    native.ProjectionRootIdentityLock = class {
      constructor() {
        throw new Error("projection root operation failed: sharing violation (os error 32)");
      }
    };
    attemptAcquire();
    attemptAcquire();
    attemptAcquire();
    now += 59_999;
    const justBeforeCoolOff = isProjectionRootIdentityLockAvailable();
    now += 1;
    const atCoolOff = isProjectionRootIdentityLockAvailable();
    const reProbeError = attemptAcquire();
    const reLatched = isProjectionRootIdentityLockAvailable();
    process.stdout.write(JSON.stringify({ justBeforeCoolOff, atCoolOff, reProbeError, reLatched }));
  `);

  assert.equal(output.justBeforeCoolOff, false, "still latched one millisecond before the cool-off");
  assert.equal(output.atCoolOff, true, "cool-off must let the gate re-probe the native layer");
  assert.match(output.reProbeError, /locking failed/);
  assert.equal(output.reLatched, false, "a failure after the re-probe must re-latch immediately");
});

test("a successful open recovers a failing-open streak; stale counts do not survive a cool-off re-probe", () => {
  const output = runLatchScenario(`${patchHelper}
    let openShouldFail = true;
    native.ProjectionRootIdentityLock = class {
      constructor() {
        if (openShouldFail) {
          throw new Error("projection root operation failed: busy (os error 32)");
        }
      }
    };
    // Alternating open failures and successes never latch: each failure is
    // recovered by the next successful open of the same operation.
    openShouldFail = true;
    attemptAcquire();
    openShouldFail = false;
    attemptAcquire();
    openShouldFail = true;
    attemptAcquire();
    openShouldFail = false;
    attemptAcquire();
    openShouldFail = true;
    const alternating = isProjectionRootIdentityLockAvailable();
    // The streak was fully recovered, so the threshold applies from zero:
    // two failures stay available, the third latches.
    attemptAcquire();
    attemptAcquire();
    const belowThreshold = isProjectionRootIdentityLockAvailable();
    attemptAcquire();
    const latched = isProjectionRootIdentityLockAvailable();
    // After the cool-off re-probe, the stale count must not re-latch from a
    // single failure: recovery reset it, so the threshold applies anew.
    const { _setProjectionRootIdentityLockClockForTest, _resetProjectionRootIdentityLockHealthForTest } = require("./dist/file-identity");
    let now = 1_000_000;
    _setProjectionRootIdentityLockClockForTest(() => now);
    _resetProjectionRootIdentityLockHealthForTest();
    openShouldFail = true;
    attemptAcquire();
    attemptAcquire();
    attemptAcquire();
    now += 61_000;
    const reProbeAvailable = isProjectionRootIdentityLockAvailable();
    openShouldFail = false;
    attemptAcquire();
    openShouldFail = true;
    attemptAcquire();
    const freshThreshold = isProjectionRootIdentityLockAvailable();
    process.stdout.write(JSON.stringify({ alternating, belowThreshold, latched, reProbeAvailable, freshThreshold }));
  `);

  assert.equal(output.alternating, true, "recovered open streaks must not latch");
  assert.equal(output.belowThreshold, true);
  assert.equal(output.latched, false);
  assert.equal(output.reProbeAvailable, true);
  assert.equal(output.freshThreshold, true, "post-cool-off threshold applies from zero after recovery");
});

test("latch state is resettable for tests", () => {
  const output = runLatchScenario(`${patchHelper}
    const { _resetProjectionRootIdentityLockHealthForTest } = require("./dist/file-identity");
    native.ProjectionRootIdentityLock = class {
      constructor() {
        throw new Error("projection root operation failed: busy (os error 32)");
      }
    };
    attemptAcquire();
    attemptAcquire();
    attemptAcquire();
    const latched = isProjectionRootIdentityLockAvailable();
    _resetProjectionRootIdentityLockHealthForTest();
    process.stdout.write(JSON.stringify({ latched, reset: isProjectionRootIdentityLockAvailable() }));
  `);

  assert.equal(output.latched, false);
  assert.equal(output.reset, true);
});
