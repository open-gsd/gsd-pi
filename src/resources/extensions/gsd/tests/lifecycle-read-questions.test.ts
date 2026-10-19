// Project/App: gsd-pi
// File Purpose: Behavior tests for the canonical blocker and open-question
// answers of the read interface (db/lifecycle-read.ts). Canonical storage has
// no legacy row, so the answers are the same at every Authority Epoch, and the
// project snapshot reads them through the interface, not at its own SQL.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _executeAuthorityCutoverDomainOperation,
  type DomainOperationMutation,
} from "../db/domain-operation.ts";
import { readOpenBlockers, readOpenQuestions } from "../db/lifecycle-read.ts";
import { insertAuthorityCutoverReceipt } from "../db/writers/authority-recovery.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  getProjectAuthorityRow,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import { readProjectSnapshotFromDb } from "../state/project-snapshot.ts";

const tempDirectories = new Set<string>();

afterEach(() => {
  closeDatabase();
  invalidateStateCache();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function makeProject(): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-lifecycle-read-questions-")));
  tempDirectories.add(base);
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  return base;
}

function mutation(key: string): DomainOperationMutation {
  return {
    events: [{
      eventType: "lifecycle-read-questions.seeded",
      entityType: "project",
      entityId: key,
      payload: { key },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `lifecycle-read-questions/${key}`,
      projectionKind: "markdown",
      rendererVersion: "v1",
    }],
  };
}

/** Advance the Authority Epoch of the Project from 0 to 1. */
function cutOver(): void {
  const fence = readDomainOperationFence();
  const evidenceHash = `sha256:${"3".repeat(64)}`;
  const consentHash = `sha256:${"4".repeat(64)}`;
  const cutover = _executeAuthorityCutoverDomainOperation({
    operationType: "authority.cutover",
    idempotencyKey: "lifecycle-read-questions/cutover",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    actorId: "lifecycle-read-questions",
    sourceTransport: "internal",
    payload: { authorityContractVersion: 1, evidenceHash, consentHash },
  }, (context) => {
    insertAuthorityCutoverReceipt(context, { authorityContractVersion: 1, evidenceHash, consentHash });
    return mutation("cutover");
  });
  assert.equal(cutover.resultingAuthorityEpoch, 1);
  invalidateStateCache();
}

// Provenance seeds. workflow_blockers / workflow_open_questions reference
// workflow_operations and workflow_item_lifecycles, so the seeds build that
// minimal provenance chain first (the same shape the project-snapshot tests
// use). Revisions sit far above the authority revision so the seed never
// collides with a real writer operation.
const SEED_REVISION_BASE = 920_001;

function fixtureProjectId(): string {
  const authority = getProjectAuthorityRow();
  assert.ok(authority, "fixture project_authority row should exist");
  return authority.projectId;
}

function seedOperation(operationId: string, revision: number): void {
  _getAdapter()!.prepare(
    `INSERT INTO workflow_operations (
       operation_id, project_id, operation_type, idempotency_key,
       expected_revision, resulting_revision,
       expected_authority_epoch, resulting_authority_epoch,
       actor_type, actor_id, source_transport, request_hash, created_at
     ) VALUES (?, ?, 'questions-test', ?, ?, ?, 0, 0, 'agent', 'test', 'test', ?, '2026-10-05T00:00:00.000Z')`,
  ).run(
    operationId,
    fixtureProjectId(),
    `key-${operationId}`,
    revision - 1,
    revision,
    `hash-${operationId}`,
  );
}

function seedMilestoneLifecycle(
  lifecycleId: string,
  operationId: string,
  revision: number,
): void {
  _getAdapter()!.prepare(
    `INSERT INTO workflow_item_lifecycles (
       lifecycle_id, project_id, item_kind, milestone_id, lifecycle_status,
       created_at, updated_at,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES (?, ?, 'milestone', 'M001', 'in_progress', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', ?, ?, 0)`,
  ).run(lifecycleId, fixtureProjectId(), operationId, revision);
}

function seedBlocker(input: {
  blockerId: string;
  lifecycleId: string;
  operationId: string;
  revision: number;
  openedAt: string;
}): void {
  _getAdapter()!.prepare(
    `INSERT INTO workflow_blockers (
       blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
       blocker_status, description, requested_action, opened_at,
       opened_operation_id, opened_project_revision, opened_authority_epoch
     ) VALUES (?, ?, ?, 'ambiguous_intent', 'user', 'open', ?, ?, ?, ?, ?, 0)`,
  ).run(
    input.blockerId,
    fixtureProjectId(),
    input.lifecycleId,
    `${input.blockerId} description`,
    `${input.blockerId} requested action`,
    input.openedAt,
    input.operationId,
    input.revision,
  );
}

function seedQuestion(input: {
  questionId: string;
  lifecycleId: string;
  operationId: string;
  revision: number;
  text: string;
  createdAt: string;
}): void {
  // A question that begins open has created/last provenance that matches and
  // created_at == updated_at.
  _getAdapter()!.prepare(
    `INSERT INTO workflow_open_questions (
       question_id, project_id, lifecycle_id, question_text, question_status,
       state_version, created_at, updated_at,
       created_operation_id, created_project_revision, created_authority_epoch,
       last_operation_id, last_project_revision, last_authority_epoch
     ) VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, 0, ?, ?, 0)`,
  ).run(
    input.questionId,
    fixtureProjectId(),
    input.lifecycleId,
    input.text,
    input.createdAt,
    input.createdAt,
    input.operationId,
    input.revision,
    input.operationId,
    input.revision,
  );
}

/** One Milestone with an open and a closed blocker and an open and a withdrawn question. */
function seedCanonicalQuestions(): string {
  const base = makeProject();
  insertMilestone({ id: "M001", title: "Blocked milestone", status: "active" });
  const revision = SEED_REVISION_BASE;
  seedOperation("op-questions", revision);
  seedMilestoneLifecycle("lc-M001", "op-questions", revision);
  seedBlocker({
    blockerId: "B-01",
    lifecycleId: "lc-M001",
    operationId: "op-questions",
    revision,
    openedAt: "2026-10-05T00:00:01.000Z",
  });
  seedBlocker({
    blockerId: "B-00",
    lifecycleId: "lc-M001",
    operationId: "op-questions",
    revision,
    openedAt: "2026-10-05T00:00:02.000Z",
  });
  // The resolution needs its own operation at a later revision (the causal
  // provenance of a resolved blocker must advance).
  seedOperation("op-questions-resolve", revision + 1);
  _getAdapter()!.prepare(`
    UPDATE workflow_blockers
       SET blocker_status = 'resolved', resolved_at = '2026-10-05T00:00:05.000Z',
           resolved_operation_id = 'op-questions-resolve',
           resolved_project_revision = :revision,
           resolved_authority_epoch = 0
     WHERE blocker_id = 'B-00'
  `).run({ ":revision": revision + 1 });
  seedQuestion({
    questionId: "Q-01",
    lifecycleId: "lc-M001",
    operationId: "op-questions",
    revision,
    text: "Which way?",
    createdAt: "2026-10-05T00:00:03.000Z",
  });
  seedQuestion({
    questionId: "Q-00",
    lifecycleId: "lc-M001",
    operationId: "op-questions",
    revision,
    text: "Withdrawn way?",
    createdAt: "2026-10-05T00:00:04.000Z",
  });
  // The withdrawal is a transition: it advances the provenance (state version
  // and revision) like the Domain Operation that withdraws a question does.
  seedOperation("op-questions-withdraw", revision + 2);
  _getAdapter()!.prepare(`
    UPDATE workflow_open_questions
       SET question_status = 'withdrawn', state_version = state_version + 1,
           last_operation_id = 'op-questions-withdraw',
           last_project_revision = :revision,
           updated_at = '2026-10-05T00:00:06.000Z'
     WHERE question_id = 'Q-00'
  `).run({ ":revision": revision + 2 });
  invalidateStateCache();
  return base;
}

test("the read interface answers the open canonical blockers and questions at every Authority Epoch", () => {
  seedCanonicalQuestions();
  const answers = () => ({
    blockers: readOpenBlockers().map((blocker) => [
      blocker.blockerId,
      blocker.blockerKind,
      blocker.resolutionOwner,
      blocker.description,
      blocker.requestedAction,
      blocker.openedProjectRevision,
    ]),
    questions: readOpenQuestions().map((question) => [question.questionId, question.questionText]),
  });

  assert.deepEqual(answers(), {
    blockers: [[
      "B-01",
      "ambiguous_intent",
      "user",
      "B-01 description",
      "B-01 requested action",
      SEED_REVISION_BASE,
    ]],
    questions: [["Q-01", "Which way?"]],
  }, "a resolved blocker and a withdrawn question are not answered");

  cutOver();

  assert.deepEqual(answers(), {
    blockers: [[
      "B-01",
      "ambiguous_intent",
      "user",
      "B-01 description",
      "B-01 requested action",
      SEED_REVISION_BASE,
    ]],
    questions: [["Q-01", "Which way?"]],
  }, "canonical storage has no legacy row, so the Cutover does not change the answer");
});

test("the project snapshot reads its blockers and questions through the read interface", async () => {
  const base = seedCanonicalQuestions();
  const snapshotAnswers = async () => {
    const snapshot = await readProjectSnapshotFromDb(base);
    assert.ok(snapshot);
    return {
      blockers: snapshot.blockers.map((blocker) => blocker.blockerId),
      openQuestions: snapshot.openQuestions.map((question) => question.questionId),
    };
  };

  assert.deepEqual(await snapshotAnswers(), {
    blockers: readOpenBlockers().map((blocker) => blocker.blockerId),
    openQuestions: readOpenQuestions().map((question) => question.questionId),
  });

  cutOver();

  assert.deepEqual(await snapshotAnswers(), {
    blockers: readOpenBlockers().map((blocker) => blocker.blockerId),
    openQuestions: readOpenQuestions().map((question) => question.questionId),
  });
});
