// Project/App: gsd-pi
// File Purpose: Offline canonical-ledger regressions for bounded run recovery.
// Only temporary SQLite databases, initialized by openDatabase's real schema.
// Calling the host API here is synthetic domain provenance, NOT evidence that a
// native UI received a real user's approval key. Command/parser tests own that.
// Verification: NOT RUN locally (operator requires online-only execution).
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { _queueApprovedAutoRecoveryForTest, startAutoDetached } from "../auto.ts";
import { autoSession } from "../auto-runtime-state.ts";
import { drainProjectionWork, preserveProjectionChanges, rebuildMarkdownProjectionsFromDb } from "../projection-worker.ts";
import { readCompatMarker } from "../compat/compat-marker.ts";
import { listProjectionWorkHeads } from "../db/writers/projection-work-delivery.ts";

import {
  AUTO_RECOVERY_APPROVAL_TTL_MS,
  AUTO_RECOVERY_MAX_RETRIES,
  authorizeAutoRecovery,
  canAutomaticallyRecover,
  consumeAutoRecoveryRetry,
  revokeAutoRecovery,
} from "../auto-recovery-authorization.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  closeAutoPause,
  openAutoPause,
  readOpenAutoPause,
  setAutoPauseBlockerId,
} from "../db/writers/auto-pauses.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import type { PausedSessionMetadata } from "../interrupted-session.ts";
import { findPauseLifecycleId, openPauseBlockerRow } from "../pause-blocker-domain-operation.ts";
import type { RecoveryClassification } from "../recovery-classification.ts";
import type { AutoPauseBlockerKind, HumanBlockerKind } from "../recovery-policy.ts";

const RUN = "run-approval-test";
const RUN_APPROVAL_ID = "approval-test";
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const RETRY: RecoveryClassification = {
  failureKind: "tool-schema",
  action: "retry",
  reason: "Mechanical schema correction",
  exitReason: "retry",
  remediation: "Retry the corrected mechanical operation",
};
const HUMAN_KINDS: readonly HumanBlockerKind[] = [
  "missing_authority", "missing_access", "external_dependency", "consent",
  "ambiguous_intent", "subjective_uat", "user_limit",
];

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-auto-recovery-authorization-"));
  t.after(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  openDatabase(join(dir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.auto-recovery.seed",
    idempotencyKey: "test/auto-recovery/seed",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    for (const unit of [
      { itemKind: "milestone" as const, milestoneId: "M001", lifecycleStatus: "ready" as const },
      { itemKind: "slice" as const, milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready" as const },
      { itemKind: "task" as const, milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "ready" as const },
    ]) adoptOrTransitionLifecycle(context, unit);
    return {
      projections: [{ projectionKey: "test/auto-recovery/seed", projectionKind: "test", rendererVersion: "1" }],
      events: [{ eventType: "test.auto-recovery.seeded", entityType: "project", entityId: "M001", payload: {}, destinations: ["test"] }],
    };
  });
  return dir;
}

function approvalInput(authorizationId = RUN_APPROVAL_ID) {
  const fence = readDomainOperationFence();
  return {
    authorizationId, runId: RUN, expectedProjectId: fence.projectId,
    expectedRevision: fence.revision, expectedAuthorityEpoch: fence.authorityEpoch,
  };
}

function approve(authorizationId = RUN_APPROVAL_ID): string {
  return authorizeAutoRecovery(approvalInput(authorizationId));
}

function pause(overrides: Partial<PausedSessionMetadata> = {}) {
  const metadata = {
    pauseId: "pause-test", milestoneId: "M001", unitType: "execute-task",
    unitId: "M001/S01/T01", pausedAt: new Date(NOW).toISOString(),
    dispatchId: null, stepMode: false, blockerKind: "machine_fixable",
    pauseReason: "recovery:tool-schema/retry | Mechanical correction",
    ...overrides,
  } satisfies PausedSessionMetadata;
  // The production writer requires a classified kind, unlike legacy metadata.
  assert.ok(metadata.blockerKind);
  openAutoPause({ ...metadata, blockerKind: metadata.blockerKind });
  assert.ok(metadata.pausedAt);
  return {
    authorizationId: RUN_APPROVAL_ID, runId: RUN, pausedAt: metadata.pausedAt,
    dispatchId: metadata.dispatchId ?? null, classification: RETRY,
  };
}

function events(type: string, id = RUN_APPROVAL_ID) {
  return db().prepare(`
    SELECT * FROM workflow_domain_events
    WHERE entity_type = 'auto-recovery-authorization'
      AND entity_id = :id AND event_type = :type
    ORDER BY project_revision, event_index
  `).all({ ":id": id, ":type": type });
}

function protectedState() {
  return [
    "tasks", "workflow_item_lifecycles", "workflow_execution_attempts",
    "workflow_attempt_results", "workflow_failure_observations",
    "workflow_recovery_actions", "workflow_recovery_budgets",
    "workflow_blockers", "auto_pauses",
  ].map((table) => [table, db().prepare(`SELECT * FROM ${table}`).all()]);
}

function durableState() {
  return [protectedState(), ...[
    "project_authority", "workflow_operations", "workflow_domain_events", "workflow_projection_work", "workflow_outbox",
  ].map((table) => [table, db().prepare(`SELECT * FROM ${table}`).all()])];
}

function rejectsWithoutWrites(action: () => unknown, expected: RegExp): void {
  const before = durableState();
  assert.throws(action, expected);
  assert.deepEqual(durableState(), before, "denial must not consume or mutate canonical state");
}

const APPROVAL_DENIAL = /approval is absent, expired, revoked, out of scope, or exhausted/;
const PAUSE_DENIAL = /same mechanical retry pause, without a human Blocker/;

test("pure recovery allowlist admits only mechanical retry outside step mode", () => {
  assert.equal(canAutomaticallyRecover("machine_fixable", RETRY, false), true);
  for (const kind of [...HUMAN_KINDS, "user_request", "unknown"]) {
    assert.equal(canAutomaticallyRecover(kind, RETRY, false), false, kind);
  }
  for (const action of ["escalate", "stop"] as const) {
    assert.equal(canAutomaticallyRecover("machine_fixable", { ...RETRY, action }, false), false);
  }
  assert.equal(canAutomaticallyRecover("machine_fixable", RETRY, true), false);
});

test("host approval records immutable user/internal provenance and the fixed bounded grant", (t) => {
  fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  t.after(() => t.mock.timers.reset());
  const input = approvalInput();
  const before = protectedState();
  assert.equal(authorizeAutoRecovery(input), RUN_APPROVAL_ID);
  assert.equal(AUTO_RECOVERY_MAX_RETRIES, 3);
  assert.equal(AUTO_RECOVERY_APPROVAL_TTL_MS, 30 * 60 * 1000);
  const issued = events("auto.recovery.authorized");
  assert.equal(issued.length, 1);
  const work = db().prepare("SELECT projection_kind, renderer_version FROM workflow_projection_work WHERE projection_key = :key")
    .get({ ":key": `auto-recovery/${RUN_APPROVAL_ID}` });
  assert.equal(work?.projection_kind, "auto-recovery-authorization");
  assert.equal(work?.renderer_version, "1");
  assert.equal(issued[0]?.project_id, input.expectedProjectId);
  assert.equal(issued[0]?.authority_epoch, input.expectedAuthorityEpoch);
  assert.deepEqual(JSON.parse(String(issued[0]?.payload_json)), {
    version: 1, runId: RUN, maxRetries: 3, allowedKind: "machine_fixable",
    allowedAction: "retry", expiresAt: NOW + AUTO_RECOVERY_APPROVAL_TTL_MS,
  });
  const operation = db().prepare(`
    SELECT operation_type, actor_type, source_transport FROM workflow_operations
    WHERE operation_id = :id
  `).get({ ":id": issued[0]?.operation_id });
  assert.deepEqual(operation && { ...operation }, {
    operation_type: "auto.recovery.authorize", actor_type: "user", source_transport: "internal",
  });
  const afterIssue = durableState();
  assert.equal(authorizeAutoRecovery(input), RUN_APPROVAL_ID);
  assert.deepEqual(durableState(), afterIssue, "approval replay cannot extend expiry or reset budget");
  assert.deepEqual(protectedState(), before);
});

test("approval rejects empty identities and a mismatched project without writes", (t) => {
  fixture(t);
  const input = approvalInput();
  for (const invalid of [{ authorizationId: " " }, { runId: " " }]) {
    rejectsWithoutWrites(() => authorizeAutoRecovery({ ...input, ...invalid }), /run identity/);
  }
  rejectsWithoutWrites(() => authorizeAutoRecovery({ ...input, expectedProjectId: "another-project" }), /Project changed/);
});

test("approval honors the caller's revision and Authority Epoch fences", (t) => {
  fixture(t);
  const input = approvalInput();
  rejectsWithoutWrites(() => authorizeAutoRecovery({ ...input, expectedRevision: input.expectedRevision - 1 }), /revision/i);
  rejectsWithoutWrites(() => authorizeAutoRecovery({ ...input, expectedAuthorityEpoch: input.expectedAuthorityEpoch + 1 }), /epoch/i);
});

test("an agent or non-native transport cannot mint a usable grant by emitting the event", (t) => {
  fixture(t);
  const request = pause();
  for (const [actorType, sourceTransport] of [["agent", "internal"], ["user", "mcp"]]) {
    const authorizationId = `untrusted-${actorType}-${sourceTransport}`;
    const fence = readDomainOperationFence();
    // Deliberately untrusted canonical provenance, not a fake user/owner override.
    executeDomainOperation({
      operationType: "auto.recovery.authorize", idempotencyKey: authorizationId,
      expectedRevision: fence.revision, expectedAuthorityEpoch: fence.authorityEpoch,
      actorType, sourceTransport, payload: {},
    }, () => ({
      projections: [{ projectionKey: `test/auto-recovery/${authorizationId}`, projectionKind: "test", rendererVersion: "1" }],
      events: [{
        eventType: "auto.recovery.authorized", entityType: "auto-recovery-authorization",
        entityId: authorizationId, destinations: ["test"], payload: {
          version: 1, runId: RUN, maxRetries: 3, allowedKind: "machine_fixable",
          allowedAction: "retry", expiresAt: Date.now() + AUTO_RECOVERY_APPROVAL_TTL_MS,
        },
      }],
    }));
    rejectsWithoutWrites(() => consumeAutoRecoveryRetry({ ...request, authorizationId }), APPROVAL_DENIAL);
  }
});

test("consumption is agent/internal reservation only, never Task retry or pause closure", (t) => {
  fixture(t);
  approve();
  const request = pause();
  const before = protectedState();
  assert.equal(consumeAutoRecoveryRetry(request), true);
  assert.deepEqual(protectedState(), before);
  assert.ok(readOpenAutoPause());
  const reserved = events("auto.recovery.retry-reserved");
  assert.equal(reserved.length, 1);
  const operation = db().prepare(`
    SELECT operation_type, actor_type, source_transport FROM workflow_operations
    WHERE operation_id = :id
  `).get({ ":id": reserved[0]?.operation_id });
  assert.deepEqual(operation && { ...operation }, {
    operation_type: "auto.recovery.retry", actor_type: "agent", source_transport: "internal",
  });
  assert.deepEqual(JSON.parse(String(reserved[0]?.payload_json)), {
    runId: RUN, pausedAt: request.pausedAt, dispatchId: null, failureKind: RETRY.failureKind,
  });
});

test("missing approval fails closed", (t) => {
  fixture(t);
  const request = pause();
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), APPROVAL_DENIAL);
});

test("approval is not transferable to another run", (t) => {
  fixture(t);
  approve();
  const request = pause();
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry({ ...request, runId: "another-run" }), APPROVAL_DENIAL);
});

test("approval from a different temporary project database is unusable", (t) => {
  fixture(t);
  const firstProject = readDomainOperationFence().projectId;
  approve();
  closeDatabase();
  fixture(t);
  assert.notEqual(readDomainOperationFence().projectId, firstProject);
  const request = pause();
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), APPROVAL_DENIAL);
});

test("an Authority Epoch change invalidates the old grant", (t) => {
  fixture(t);
  approve();
  const request = pause();
  // Same real-schema authority-change fixture used by domain-operation.test.ts;
  // no trigger removal, guard suppression, or real project database access.
  db().prepare(`
    UPDATE project_authority SET revision = revision + 1, authority_epoch = authority_epoch + 1
    WHERE singleton = 1
  `).run();
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), APPROVAL_DENIAL);
});

test("expiry permits one millisecond before the deadline but rejects the exact deadline", (t) => {
  fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  t.after(() => t.mock.timers.reset());
  approve();
  approve("deadline-grant");
  const request = pause();
  t.mock.timers.setTime(NOW + AUTO_RECOVERY_APPROVAL_TTL_MS - 1);
  assert.equal(consumeAutoRecoveryRetry(request), true);
  t.mock.timers.setTime(NOW + AUTO_RECOVERY_APPROVAL_TTL_MS);
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry({ ...request, authorizationId: "deadline-grant" }), APPROVAL_DENIAL);
  assert.equal(events("auto.recovery.retry-reserved", "deadline-grant").length, 0);
});

test("revocation is durable, agent-attributed, idempotent, and leaves pauses and Tasks alone", (t) => {
  fixture(t);
  approve();
  const request = pause();
  const before = protectedState();
  revokeAutoRecovery(RUN_APPROVAL_ID, RUN);
  assert.deepEqual(protectedState(), before);
  const revoked = events("auto.recovery.revoked");
  assert.equal(revoked.length, 1);
  const operation = db().prepare(`
    SELECT actor_type, source_transport FROM workflow_operations WHERE operation_id = :id
  `).get({ ":id": revoked[0]?.operation_id });
  assert.deepEqual(operation && { ...operation }, { actor_type: "agent", source_transport: "internal" });
  const afterRevoke = durableState();
  revokeAutoRecovery(RUN_APPROVAL_ID, RUN);
  assert.deepEqual(durableState(), afterRevoke);
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), APPROVAL_DENIAL);
});

test("wrong-run revocation cannot revoke a valid grant", (t) => {
  fixture(t);
  approve();
  const request = pause();
  rejectsWithoutWrites(() => revokeAutoRecovery(RUN_APPROVAL_ID, "another-run"), /different auto-recover run/);
  assert.equal(consumeAutoRecoveryRetry(request), true);
});

test("consumption requires the exact open timestamp and dispatch, not a changed or closed pause", (t) => {
  fixture(t);
  approve();
  const request = pause();
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry({ ...request, pausedAt: new Date(NOW + 1).toISOString() }), PAUSE_DENIAL);
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry({ ...request, dispatchId: 1 }), PAUSE_DENIAL);
  pause({ pausedAt: new Date(NOW + 2).toISOString() });
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), PAUSE_DENIAL);
  closeAutoPause();
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), PAUSE_DENIAL);
});

test("recorded retry route must match exactly, rejecting escalate/stop and retry-prefix lookalikes", (t) => {
  fixture(t);
  approve();
  for (const pauseReason of [
    "recovery:tool-schema/escalate", "recovery:tool-schema/stop",
    "recovery:tool-contract/retry", "recovery:tool-schema/retrying",
    "recovery:tool-schema/retry-later", "legacy pause without a recorded route",
  ]) {
    const request = pause({ pauseReason });
    rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), PAUSE_DENIAL);
  }
});

test("every human kind, user-request pause, and step mode preserve the full retry budget", (t) => {
  fixture(t);
  approve();
  for (const blockerKind of [...HUMAN_KINDS, "user_request"] satisfies AutoPauseBlockerKind[]) {
    const request = pause({ blockerKind });
    rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), PAUSE_DENIAL);
  }
  const stepRequest = pause({ stepMode: true });
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(stepRequest), PAUSE_DENIAL);
  assert.equal(events("auto.recovery.retry-reserved").length, 0);
  assert.equal(consumeAutoRecoveryRetry(pause()), true);
});

test("a linked real user-owned Blocker cannot be bypassed or closed by a mechanical grant", (t) => {
  fixture(t);
  approve();
  const request = pause();
  const lifecycleId = findPauseLifecycleId({ milestoneId: "M001", unitType: "execute-task", unitId: "M001/S01/T01" });
  assert.ok(lifecycleId);
  const { blockerId } = openPauseBlockerRow({
    lifecycleId,
    blockerKind: "consent", description: "Operator consent required",
    requestedAction: "Confirm the action",
    idempotencyKey: "test/auto-recovery/human-blocker",
  });
  assert.ok(blockerId, "canonical lifecycle fixture must create a real Blocker");
  setAutoPauseBlockerId(blockerId);
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), PAUSE_DENIAL);
  const blocker = db().prepare(`
    SELECT blocker_status, resolution_owner FROM workflow_blockers WHERE blocker_id = :id
  `).get({ ":id": blockerId });
  assert.deepEqual(blocker && { ...blocker }, { blocker_status: "open", resolution_owner: "user" });
});

test("escalate and stop classifications return false without consuming or writing anything", (t) => {
  fixture(t);
  approve();
  const request = pause();
  for (const action of ["escalate", "stop"] as const) {
    const before = durableState();
    assert.equal(consumeAutoRecoveryRetry({ ...request, classification: { ...RETRY, action } }), false);
    assert.deepEqual(durableState(), before);
  }
  assert.equal(consumeAutoRecoveryRetry(request), true);
});

test("three distinct reservations exhaust the grant; every replay including the final use schedules false", (t) => {
  fixture(t);
  const originalInput = approvalInput();
  authorizeAutoRecovery(originalInput);
  const requests = [];
  for (let index = 0; index < 3; index += 1) {
    const request = pause({ pausedAt: new Date(NOW + index).toISOString() });
    requests.push(request);
    const before = protectedState();
    assert.equal(consumeAutoRecoveryRetry(request), true);
    assert.deepEqual(protectedState(), before);
    const afterReserve = durableState();
    assert.equal(consumeAutoRecoveryRetry(request), false, "replay must not schedule another resume");
    assert.deepEqual(durableState(), afterReserve);
    assert.equal(events("auto.recovery.retry-reserved").length, index + 1);
  }
  const exhausted = durableState();
  for (const request of requests) {
    assert.equal(consumeAutoRecoveryRetry(request), false, "final-budget replay is not a new reservation or exhaustion error");
  }
  assert.equal(authorizeAutoRecovery(originalInput), RUN_APPROVAL_ID);
  assert.deepEqual(durableState(), exhausted, "replaying approval cannot replenish exhausted budget");
  const fourth = pause({ pausedAt: new Date(NOW + 3).toISOString() });
  rejectsWithoutWrites(() => consumeAutoRecoveryRetry(fourth), APPROVAL_DENIAL);
  assert.equal(events("auto.recovery.retry-reserved").length, 3);
});

test("retry route requires an exact token, not retrying or retry-later", (t) => {
  fixture(t); approve();
  for (const action of ["retrying", "retry-later"]) {
    const request = pause({ pauseReason: `recovery:tool-schema/${action} | not an approved retry` });
    rejectsWithoutWrites(() => consumeAutoRecoveryRetry(request), PAUSE_DENIAL);
  }
});

function attachHost(t: TestContext) {
  autoSession.reset();
  t.after(() => autoSession.reset());
  autoSession.autoRecoveryAuthorizationId = RUN_APPROVAL_ID;
  autoSession.autoRecoveryRunId = RUN;
  autoSession.paused = true;
  autoSession.originalBasePath = "/synthetic-host-project";
  autoSession.cmdCtx = { ui: { notify() {} } } as unknown as ExtensionCommandContext;
}

test("host schedules one normal resume and forwards the persisted milestone lock", async (t) => {
  fixture(t); approve(); pause({ milestoneLock: "M001" }); attachHost(t);
  const calls: Parameters<typeof startAutoDetached>[] = [];
  const resume: typeof startAutoDetached = (...args) => { calls.push(args); return Promise.resolve(true); };
  const before = protectedState();
  assert.equal(_queueApprovedAutoRecoveryForTest({} as ExtensionAPI, RETRY, resume), true);
  assert.equal(_queueApprovedAutoRecoveryForTest({} as ExtensionAPI, RETRY, resume), false);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[2], "/synthetic-host-project");
  assert.deepEqual(calls[0]?.[4], { milestoneLock: "M001" });
  assert.deepEqual(protectedState(), before, "scheduling is not a Task or Blocker transition");
  assert.equal(_queueApprovedAutoRecoveryForTest({} as ExtensionAPI, RETRY, resume), false,
    "same pause receipt cannot schedule a second resume");
});

test("operator stop wins between retry reservation and scheduled callback", async (t) => {
  fixture(t); approve(); pause(); attachHost(t);
  let calls = 0;
  assert.equal(_queueApprovedAutoRecoveryForTest({} as ExtensionAPI, RETRY, () => { calls += 1; return Promise.resolve(true); }), true);
  autoSession.reset();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("changed pause cannot be resumed by a stale scheduled callback", async (t) => {
  fixture(t); approve(); pause(); attachHost(t);
  let calls = 0;
  assert.equal(_queueApprovedAutoRecoveryForTest({} as ExtensionAPI, RETRY, () => { calls += 1; return Promise.resolve(true); }), true);
  pause({ pausedAt: new Date(NOW + 1).toISOString() });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("closed pause is null-safe and cannot be resumed by the queued callback", async (t) => {
  fixture(t); approve(); pause(); attachHost(t);
  let calls = 0;
  assert.equal(_queueApprovedAutoRecoveryForTest({} as ExtensionAPI, RETRY, () => { calls += 1; return Promise.resolve(true); }), true);
  closeAutoPause();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("authorization, reservation and revocation projections actually drain to an audit file", async (t) => {
  const root = fixture(t);
  const flush = async (eventType: string) => {
    const result = await drainProjectionWork(root);
    assert.deepEqual(result.errors, []);
    assert.ok(result.delivered > 0, "authorization work must be delivered, not silently skipped");
    assert.equal(listProjectionWorkHeads(["pending", "claimed", "dead_letter"])
      .filter((row) => row.projection_kind === "auto-recovery-authorization").length, 0);
    assert.match(readFileSync(join(root, ".gsd", "AUTO-RECOVERY.md"), "utf-8"), new RegExp(eventType));
  };
  approve();
  await flush("auto.recovery.authorized");
  const metadata = pause();
  consumeAutoRecoveryRetry({ authorizationId: RUN_APPROVAL_ID, runId: RUN,
    pausedAt: metadata.pausedAt, dispatchId: null, classification: RETRY });
  await flush("auto.recovery.retry-reserved");
  revokeAutoRecovery(RUN_APPROVAL_ID, RUN);
  await flush("auto.recovery.revoked");
});

test("audit projection registers an external-edit preservation baseline", async (t) => {
  const root = fixture(t); approve();
  await drainProjectionWork(root);
  assert.ok(Object.keys(readCompatMarker(root).projections).some((key) => key.endsWith("AUTO-RECOVERY.md")));
  const path = join(root, ".gsd", "AUTO-RECOVERY.md");
  appendFileSync(path, "\nOperator note: retain these bytes.\n");
  const observed = await preserveProjectionChanges(root, true);
  assert.ok(observed.preserved.some((entry) => entry.sourcePath === path));
});

test("full canonical rebuild restores the audit without pending authorization work", async (t) => {
  const root = fixture(t); approve();
  await drainProjectionWork(root);
  const path = join(root, ".gsd", "AUTO-RECOVERY.md");
  unlinkSync(path);
  await rebuildMarkdownProjectionsFromDb(root);
  assert.match(readFileSync(path, "utf-8"), /auto\.recovery\.authorized/);
});
