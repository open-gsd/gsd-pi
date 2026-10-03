// Project/App: gsd-pi
// File Purpose: Milestone reopen and completion events are read from the database only; event-log.jsonl enters by doctor --fix.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { checkEngineHealth } from "../doctor-engine-checks.ts";
import { filterDoctorIssues } from "../doctor-format.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  completedEventCoversDispatch,
  latestExplicitReopenAt,
  unimportedLegacyMilestoneEvents,
} from "../milestone-reopen-events.ts";
import { workflowEventArchivePath } from "../workflow-event-ledger.ts";
import { appendEvent } from "../workflow-events.ts";

const COMPLETED_AT = "2026-07-14T10:00:00.000Z";
const REOPENED_AT = "2026-07-15T10:00:00.000Z";

let base: string;

afterEach(() => {
  closeDatabase();
  rmSync(base, { recursive: true, force: true });
});

/** M001 is open in the database. Its completion is in the archive and its reopen in the active ledger. */
function seedFileOnlyHistory(): void {
  base = mkdtempSync(join(tmpdir(), "gsd-legacy-milestone-events-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Reopened before the event table", status: "active" });
  writeFileSync(
    workflowEventArchivePath(base, "M001"),
    `${JSON.stringify({ cmd: "complete_milestone", params: { milestoneId: "M001" }, ts: COMPLETED_AT, hash: "0", actor: "agent", session_id: "s" })}\n`,
  );
  appendEvent(base, { cmd: "reopen-milestone", params: { milestoneId: "M001" }, ts: REOPENED_AT, actor: "agent" });
  // Another milestone's events are never attributed to M001.
  appendEvent(base, { cmd: "reopen-milestone", params: { milestoneId: "M002" }, ts: "2026-07-16T10:00:00.000Z", actor: "agent" });
}

function rowCount(sql: string): number {
  return Number(_getAdapter()!.prepare(sql).get()!["n"]);
}

function importOperations(): number {
  return rowCount("SELECT COUNT(*) AS n FROM workflow_operations WHERE operation_type = 'milestone.legacy_events.record'");
}

async function unimportedIssues(
  options: { repair?: boolean; importFileOverrides?: boolean },
  fixesApplied: string[] = [],
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, fixesApplied, options);
  return issues.filter((issue) => issue.code === "legacy_milestone_event_unimported");
}

test("a reopen and a completion that only the file ledgers hold are not read", () => {
  seedFileOnlyHistory();

  assert.equal(latestExplicitReopenAt("M001"), null);
  assert.equal(completedEventCoversDispatch("M001", null), false);
});

test("doctor reports file-only milestone events and writes nothing until the operator asks", async () => {
  seedFileOnlyHistory();
  const eventsBefore = rowCount("SELECT COUNT(*) AS n FROM workflow_domain_events");

  for (const options of [{}, { repair: true }]) {
    const issues = await unimportedIssues(options);
    assert.deepEqual(issues.map((issue) => [issue.unitId, issue.severity, issue.fixable]), [
      ["M001", "warning", true],
      ["M001", "warning", true],
    ]);
    assert.match(issues[0]!.message, new RegExp(`M001 was completed at ${COMPLETED_AT}.*doctor --fix`));
    assert.match(issues[1]!.message, new RegExp(`M001 was reopened at ${REOPENED_AT}.*doctor --fix`));
    assert.deepEqual(filterDoctorIssues(issues), issues, "the warnings show in a plain /gsd doctor");
  }

  assert.equal(importOperations(), 0);
  assert.equal(rowCount("SELECT COUNT(*) AS n FROM workflow_domain_events"), eventsBefore);
  assert.equal(latestExplicitReopenAt("M001"), null);
});

test("doctor --fix imports the file-only milestone events once, with the times they happened", async () => {
  seedFileOnlyHistory();
  const fixesApplied: string[] = [];

  assert.deepEqual(await unimportedIssues({ repair: true, importFileOverrides: true }, fixesApplied), []);

  assert.deepEqual(fixesApplied.filter((fix) => fix.includes("event-log.jsonl")), [
    "imported 2 milestone event(s) from event-log.jsonl: M001 completed, M001 reopened",
  ]);
  assert.equal(importOperations(), 1);
  assert.equal(latestExplicitReopenAt("M001"), REOPENED_AT);
  assert.equal(completedEventCoversDispatch("M001", COMPLETED_AT), true);
  assert.equal(completedEventCoversDispatch("M001", REOPENED_AT), false, "the completion keeps its own time");

  assert.deepEqual(await unimportedIssues({ repair: true, importFileOverrides: true }), []);
  assert.equal(importOperations(), 1, "a second run has nothing to import");
});

test("a file ledger event is not imported over a canonical event of the same kind", () => {
  seedFileOnlyHistory();
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.reopen",
    idempotencyKey: "test/milestone.reopen",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, () => ({
    events: [{
      eventType: "milestone.reopened",
      entityType: "milestone",
      entityId: "M001",
      payload: {},
      destinations: ["db"],
    }],
    projections: [{ projectionKey: "milestone/m001", projectionKind: "state", rendererVersion: "1" }],
  }));

  assert.deepEqual(unimportedLegacyMilestoneEvents(base), [
    { kind: "completed", milestoneId: "M001", occurredAt: COMPLETED_AT },
  ]);
  assert.notEqual(latestExplicitReopenAt("M001"), REOPENED_AT);
});
