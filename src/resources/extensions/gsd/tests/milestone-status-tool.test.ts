// gsd-pi — Tests for gsd_milestone_status read-only query tool

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  clearNativeMilestoneStatusSourceRevisions,
  registerQueryTools,
} from "../bootstrap/query-tools.ts";
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
} from "../gsd-db.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-query-tool-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  clearNativeMilestoneStatusSourceRevisions();
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

function openTestDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
}

async function executeToolInDir(tool: any, params: Record<string, unknown>, dir: string) {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await tool.execute("test-call-id", params, undefined, undefined, {
      cwd: dir,
      sessionManager: { getSessionId: () => "test-session" },
    });
  } finally {
    process.chdir(originalCwd);
  }
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedMilestone(milestoneId: string, title: string, status = "active"): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run(milestoneId, title, status, new Date().toISOString());
}

function seedSlice(milestoneId: string, sliceId: string, status: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO slices (milestone_id, id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(milestoneId, sliceId, `Slice ${sliceId}`, status, new Date().toISOString());
}

function seedTask(milestoneId: string, sliceId: string, taskId: string, status: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
  ).run(milestoneId, sliceId, taskId, `Task ${taskId}`, status);
}

// ─── Registration ─────────────────────────────────────────────────────────────

test("registerQueryTools registers gsd_milestone_status tool", () => {
  const pi = makeMockPi();
  registerQueryTools(pi);
  const names = pi.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("gsd_milestone_status"), "Should register gsd_milestone_status");
  assert.ok(names.includes("gsd_checkpoint_db"), "Should register gsd_checkpoint_db");
});

test("gsd_milestone_status has promptGuidelines mentioning prohibited alternatives", () => {
  const pi = makeMockPi();
  registerQueryTools(pi);
  const tool = pi.tools[0];
  assert.ok(Array.isArray(tool.promptGuidelines), "promptGuidelines must be an array");
  assert.ok(tool.promptGuidelines.length >= 1, "Must have at least one guideline");
  const joined = tool.promptGuidelines.join(" ");
  assert.match(joined, /sqlite3|better-sqlite3/, "Guidelines must mention prohibited alternatives");
});

// ─── Happy path: milestone with slices and tasks ──────────────────────────────

test("gsd_milestone_status returns milestone metadata and slice statuses", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Test Milestone");
    seedSlice("M001", "S01", "complete");
    seedSlice("M001", "S02", "active");
    seedTask("M001", "S01", "T01", "done");
    seedTask("M001", "S01", "T02", "done");
    seedTask("M001", "S02", "T01", "pending");

    const expectedText = JSON.stringify({
      milestoneId: "M001",
      title: "Test Milestone",
      status: "active",
      createdAt: _getAdapter()!.prepare("SELECT created_at FROM milestones WHERE id = 'M001'").get()!["created_at"],
      completedAt: null,
      dependsOn: [],
      sliceCount: 2,
      slices: [
        { id: "S01", status: "complete", taskCounts: { total: 2, done: 2, pending: 0 } },
        { id: "S02", status: "active", taskCounts: { total: 1, done: 0, pending: 1 } },
      ],
    }, null, 2);

    let captures = 0;
    const pi = makeMockPi();
    registerQueryTools(pi, {
      captureMilestoneVerificationSourceRevision: () => {
        captures += 1;
        return { ok: true, sourceRevision: "sha256:turn-bound-source" };
      },
    });
    const tool = pi.tools[0];

    assert.equal(captures, 0, "registering an unused status tool must not capture source");

    const result = await executeToolInDir(tool, { milestoneId: "M001" }, base);
    const repeated = await executeToolInDir(tool, { milestoneId: "M001" }, base);
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(result.content[0].text, expectedText, "observation must preserve the byte-level native Pi response");
    assert.equal(repeated.content[0].text, expectedText, "repeated reads must preserve the native Pi response");
    assert.deepEqual(result.details, { operation: "milestone_status", ...JSON.parse(expectedText) });

    assert.equal(parsed.milestoneId, "M001");
    assert.equal(parsed.title, "Test Milestone");
    assert.equal(parsed.status, "active");
    assert.equal(parsed.sliceCount, 2);
    assert.equal(parsed.slices.length, 2);

    const s01 = parsed.slices.find((s: any) => s.id === "S01");
    assert.ok(s01, "S01 should be in slices");
    assert.equal(s01.status, "complete");
    assert.equal(s01.taskCounts.total, 2);
    assert.equal(s01.taskCounts.done, 2);

    const s02 = parsed.slices.find((s: any) => s.id === "S02");
    assert.ok(s02, "S02 should be in slices");
    assert.equal(s02.status, "active");
    assert.equal(s02.taskCounts.pending, 1);
    const audit = _getAdapter()!.prepare(`
      SELECT payload_json FROM audit_events WHERE type = 'lifecycle-shadow-observed'
    `).get();
    assert.ok(audit, "native Pi status reads must persist the mandatory observation with honest defaults");
    const payload = JSON.parse(String(audit["payload_json"]));
    assert.equal(payload.mode, "interactive");
    assert.equal(payload.transport, "native_pi");
    assert.equal(captures, 1, "the first status read captures source once and later reads reuse it");
    assert.equal(payload.sourceRevision, "sha256:turn-bound-source");
    assert.equal(payload.traceId, "test-call-id");
    assert.equal(payload.turnId, "test-session");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── Milestone with no slices ─────────────────────────────────────────────────

test("gsd_milestone_status returns empty slices array for milestone with no slices", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M002", "Empty Milestone");

    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M002" }, base);
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.milestoneId, "M002");
    assert.equal(parsed.sliceCount, 0);
    assert.deepEqual(parsed.slices, []);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── Missing milestone ────────────────────────────────────────────────────────

test("gsd_milestone_status returns not-found for missing milestone", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M999" }, base);
    assert.match(result.content[0].text, /M999.*not found/i);
    assert.equal(result.details.found, false);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── DB unavailable ───────────────────────────────────────────────────────────

test("gsd_milestone_status handles missing DB gracefully", async () => {
  // Create a directory without .gsd/ to ensure ensureDbOpen has nothing to open
  const base = join(tmpdir(), `gsd-no-db-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  closeDatabase(); // ensure no prior DB is open
  try {
    const pi = makeMockPi();
    registerQueryTools(pi);
    const tool = pi.tools[0];

    const result = await executeToolInDir(tool, { milestoneId: "M001" }, base);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot read milestone status." }],
      details: { operation: "milestone_status", error: "db_unavailable" },
    });
    const events = readFileSync(join(base, ".gsd", "audit", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "lifecycle-shadow-observation-loss");
    assert.equal(events[0].payload.observationLossAccounting.lossCount, 3);
    assert.deepEqual(
      events[0].payload.observationLossAccounting.causes.map((cause: { reason: string }) => cause.reason),
      ["context_resolution_failed", "shadow_query_failed", "primary_sink_failed"],
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
