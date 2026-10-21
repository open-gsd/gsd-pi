// Project/App: gsd-pi
// File Purpose: Prove Milestone lifecycle projections rebuild from canonical DB history.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainJsonValue } from "../db/domain-operation.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertArtifact,
  insertMilestone,
  openDatabase,
  readDomainOperationFence,
  updateMilestoneStatus,
} from "../gsd-db.ts";
import { latestExplicitReopenAt } from "../milestone-reopen-events.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { targetMilestoneFile } from "../paths.ts";
import { writeWorkflowEventLog } from "../workflow-event-ledger.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(status: string, completedAt: string | null = null): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-lifecycle-rebuild-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Durable Closeout", status: "active" });
  updateMilestoneStatus("M001", status, completedAt);
  return basePath;
}

function recordLifecycleEvent(
  eventType: "milestone.completed" | "milestone.reopened",
  payload: Record<string, DomainJsonValue>,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: eventType,
    idempotencyKey: `test/${eventType}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload,
  }, () => ({
    events: [{
      eventType,
      entityType: "milestone",
      entityId: "M001",
      payload,
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: "lifecycle/m001",
      projectionKind: "milestone-lifecycle",
      rendererVersion: "1",
    }],
  }));
}

test("full DB rebuild restores the canonical Milestone SUMMARY from milestone.completed", async () => {
  const completedAt = "2026-07-14T12:34:56.000Z";
  const basePath = makeBase("complete", completedAt);
  const summaryPath = targetMilestoneFile(basePath, "M001", "SUMMARY", "Durable Closeout");

  insertArtifact({
    path: "phases/01-durable-closeout/01-SUMMARY.md",
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# stale cached summary\n",
  });
  recordLifecycleEvent("milestone.completed", {
    milestoneLifecycleId: "milestone/M001",
    completedAt,
    closeout: {
      title: "M001: Durable Closeout",
      oneLiner: "The canonical closeout survived projection loss.",
      narrative: "The database event rebuilt the readable Milestone record.",
      successCriteriaResults: "All success criteria passed.",
      definitionOfDoneResults: "Definition of done satisfied.",
      requirementOutcomes: "REQ-1 satisfied.",
      keyDecisions: ["Keep the database authoritative."],
      keyFiles: ["src/index.ts"],
      lessonsLearned: ["Rebuild from immutable events."],
      followUps: "None.",
      deviations: "None.",
    },
  });

  const result = await renderAllFromDb(basePath);

  assert.deepEqual(result.errors, []);
  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /completed_at: 2026-07-14T12:34:56\.000Z/);
  assert.match(summary, /The canonical closeout survived projection loss\./);
  assert.match(summary, /Keep the database authoritative\./);
  assert.doesNotMatch(summary, /stale cached summary/);
});

test("full DB rebuild does not resurrect a cached Milestone SUMMARY after reopen", async () => {
  const basePath = makeBase("active");
  const summaryPath = targetMilestoneFile(basePath, "M001", "SUMMARY", "Durable Closeout");
  insertArtifact({
    path: "phases/01-durable-closeout/01-SUMMARY.md",
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# obsolete completed milestone\n",
  });

  const result = await renderAllFromDb(basePath);

  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(summaryPath), false);
});

test("latestExplicitReopenAt prefers the durable domain event over compatibility logs", () => {
  const basePath = makeBase("active");
  recordLifecycleEvent("milestone.reopened", {
    milestoneLifecycleId: "milestone/M001",
    reason: "Redo the milestone.",
  });
  const durableCreatedAt = String(_getAdapter()!.prepare(`
    SELECT created_at FROM workflow_domain_events
    WHERE event_type = 'milestone.reopened' AND entity_id = 'M001'
  `).get()!["created_at"]);
  writeWorkflowEventLog(basePath, [{
    v: 2,
    cmd: "reopen-milestone",
    params: { milestoneId: "M001" },
    ts: "2099-01-01T00:00:00.000Z",
    hash: "compatibility-only",
    actor: "agent",
    session_id: "compatibility-test",
  }]);

  assert.equal(latestExplicitReopenAt(basePath, "M001"), durableCreatedAt);
});

test("latestExplicitReopenAt falls back to the compatibility log without a durable event", () => {
  const basePath = makeBase("active");
  writeWorkflowEventLog(basePath, [{
    v: 2,
    cmd: "reopen-milestone",
    params: { milestoneId: "M001" },
    ts: "2026-07-14T10:00:00.000Z",
    hash: "compatibility-fallback",
    actor: "agent",
    session_id: "compatibility-test",
  }]);

  assert.equal(latestExplicitReopenAt(basePath, "M001"), "2026-07-14T10:00:00.000Z");
});
