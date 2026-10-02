// GSD State Machine Regression Tests — Event Replay & Reconciliation (#3161)

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findForkPoint, readEvents, appendEvent } from "../workflow-events.ts";
import type { WorkflowEvent } from "../workflow-events.ts";

// ─── Helper: build a full WorkflowEvent from cmd + params ────────────────────

function makeEvent(cmd: string, params: Record<string, unknown>, ts?: string): WorkflowEvent {
  const hash = createHash("sha256")
    .update(JSON.stringify({ cmd, params }))
    .digest("hex")
    .slice(0, 16);
  return { cmd, params, ts: ts ?? new Date().toISOString(), hash, actor: "agent", session_id: "test-session" };
}

// ─── Temp dir management ─────────────────────────────────────────────────────

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-recon-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconciliation-edge-cases", () => {

  // findForkPoint
  test("findForkPoint returns -1 for completely diverged logs", () => {
    const eA = makeEvent("complete_task", { milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    const eB = makeEvent("complete_task", { milestoneId: "M001", sliceId: "S01", taskId: "T02" });

    const logA: WorkflowEvent[] = [eA];
    const logB: WorkflowEvent[] = [eB];

    assert.equal(findForkPoint(logA, logB), -1, "completely diverged logs should return -1");
  });

  test("findForkPoint returns last index when one log is prefix of another", () => {
    const e1 = makeEvent("start_task", { milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    const e2 = makeEvent("complete_task", { milestoneId: "M001", sliceId: "S01", taskId: "T01" });
    const e3 = makeEvent("complete_slice", { milestoneId: "M001", sliceId: "S01" });

    const logA: WorkflowEvent[] = [e1, e2];
    const logB: WorkflowEvent[] = [e1, e2, e3];

    assert.equal(findForkPoint(logA, logB), 1, "prefix log should fork at last shared index");
  });

  test("findForkPoint returns -1 for empty logs", () => {
    assert.equal(findForkPoint([], []), -1, "two empty logs should return -1");
  });

  // appendEvent — filesystem creation
  test("appendEvent creates event log if directory does not exist", () => {
    const base = tempDir();
    // Remove the .gsd directory if it somehow exists — appendEvent should create it.
    const gsdDir = path.join(base, ".gsd");
    if (fs.existsSync(gsdDir)) fs.rmSync(gsdDir, { recursive: true, force: true });

    appendEvent(base, {
      cmd: "complete_task",
      params: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
      ts: new Date().toISOString(),
      actor: "agent",
    });

    const logPath = path.join(base, ".gsd", "event-log.jsonl");
    assert.ok(fs.existsSync(logPath), "event-log.jsonl should be created by appendEvent");

    const events = readEvents(logPath);
    assert.equal(events.length, 1, "event log should contain exactly one event");
    assert.equal(events[0]!.cmd, "complete_task", "persisted event should have the correct cmd");
  });
});
