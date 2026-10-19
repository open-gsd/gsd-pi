/**
 * Tests: awaitWorkerResume — headless worker pause survives without a resumer.
 *
 * Regression for #1273: a worker `pause` used to call a terminal pauseAuto()
 * that exited the process with BLOCKED (10). On the headless path there is no
 * resumer to send the matching `resume`, so the worker was stranded after its
 * first unit. awaitWorkerResume lets the worker wait for the coordinator to lift
 * the pause and, when no resumer responds, report "timeout" so the caller can
 * degrade to in-process serialization instead of halting forever.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeDatabase, openDatabase } from "../gsd-db.ts";
import { awaitWorkerResume, sendSignal } from "../session-status-io.ts";

/** A project database: the coordinator and the worker share it. */
function makeBase(): { cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "gsd-worker-resume-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return {
    cleanup: () => {
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

describe("awaitWorkerResume", () => {
  it("returns 'resume' when the coordinator sends resume", async () => {
    const { cleanup } = makeBase();
    try {
      sendSignal("M001", "resume");
      const outcome = await awaitWorkerResume("M001", { timeoutMs: 500, pollMs: 20 });
      assert.equal(outcome, "resume");
    } finally {
      cleanup();
    }
  });

  it("returns 'stop' when the coordinator sends stop", async () => {
    const { cleanup } = makeBase();
    try {
      sendSignal("M001", "stop");
      const outcome = await awaitWorkerResume("M001", { timeoutMs: 500, pollMs: 20 });
      assert.equal(outcome, "stop");
    } finally {
      cleanup();
    }
  });

  it("returns 'timeout' when no resumer lifts the pause (headless, #1273)", async () => {
    const { cleanup } = makeBase();
    try {
      const outcome = await awaitWorkerResume("M001", { timeoutMs: 100, pollMs: 20 });
      assert.equal(outcome, "timeout");
    } finally {
      cleanup();
    }
  });

  it("ignores a repeated pause and still resumes when resume arrives", async () => {
    const { cleanup } = makeBase();
    try {
      // A duplicate pause must not be treated as a resume, nor reset the wait.
      sendSignal("M001", "pause");
      const waiting = awaitWorkerResume("M001", { timeoutMs: 1000, pollMs: 20 });
      // Deliver the resume shortly after the pause is consumed and ignored.
      setTimeout(() => sendSignal("M001", "resume"), 60);
      const outcome = await waiting;
      assert.equal(outcome, "resume");
    } finally {
      cleanup();
    }
  });
});
