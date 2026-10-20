// Project/App: gsd-pi
// File Purpose: Canonical, run-scoped approval for bounded automatic mechanical retries.
// This never resolves a user-owned Blocker, authorizes a Task retry, or waives evidence.
import { executeDomainOperation, type DomainOperationEventInput } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { readOpenAutoPause, readOpenAutoPauseBlockerId } from "./db/writers/auto-pauses.js";
import type { RecoveryClassification } from "./recovery-classification.js";

export const AUTO_RECOVERY_MAX_RETRIES = 3;
export const AUTO_RECOVERY_APPROVAL_TTL_MS = 30 * 60 * 1000;
export const AUTO_RECOVERY_AUTHORIZATION_PROJECTION_KIND = "auto-recovery-authorization";
const ENTITY = AUTO_RECOVERY_AUTHORIZATION_PROJECTION_KIND;

interface RecoveryApproval {
  runId: string;
  projectId: string;
  authorityEpoch: number;
  expiresAt: number;
}

function event(eventType: string, id: string, payload: DomainOperationEventInput["payload"]): DomainOperationEventInput {
  return { eventType, entityType: ENTITY, entityId: id, payload, destinations: ["projection"] };
}

function projection(id: string) {
  return [{ projectionKey: `auto-recovery/${id}`, projectionKind: ENTITY, rendererVersion: "1" }];
}

function readApproval(id: string): RecoveryApproval | null {
  const row = getDb().prepare(`
    SELECT event.payload_json, event.project_id, event.authority_epoch
    FROM workflow_domain_events event
    JOIN workflow_operations operation ON operation.operation_id = event.operation_id
    WHERE event.entity_type = :entity AND event.entity_id = :id
      AND event.event_type = 'auto.recovery.authorized'
      AND operation.operation_type = 'auto.recovery.authorize'
      AND operation.actor_type = 'user' AND operation.source_transport = 'internal'
  `).get({ ":entity": ENTITY, ":id": id });
  if (!row || typeof row.payload_json !== "string") return null;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (data.version !== 1 || typeof data.runId !== "string" || !data.runId ||
      data.maxRetries !== AUTO_RECOVERY_MAX_RETRIES || data.allowedKind !== "machine_fixable" ||
      data.allowedAction !== "retry" || typeof data.expiresAt !== "number" ||
      !Number.isSafeInteger(data.expiresAt) || typeof row.project_id !== "string" ||
      typeof row.authority_epoch !== "number") return null;
  return { runId: data.runId, projectId: row.project_id,
    authorityEpoch: row.authority_epoch, expiresAt: data.expiresAt };
}

function eventCount(id: string, eventType: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE entity_type = :entity AND entity_id = :id AND event_type = :type
  `).get({ ":entity": ENTITY, ":id": id, ":type": eventType });
  return Number(row?.count ?? 0);
}

/** Host-only: call only AFTER the native custom component received an approval key.
 * No workflow/MCP tool exposes this function; an agent flag is not user consent.
 * The approval is immutable canonical ledger state, NOT runtime_kv soft state.
 */
export function authorizeAutoRecovery(input: {
  authorizationId: string;
  runId: string;
  expectedProjectId: string;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
}): string {
  if (!input.authorizationId.trim() || !input.runId.trim()) throw new Error("Auto-recover requires a run identity");
  executeDomainOperation({
    operationType: "auto.recovery.authorize",
    idempotencyKey: `auto-recovery-authorize:${input.authorizationId}`,
    expectedRevision: input.expectedRevision,
    expectedAuthorityEpoch: input.expectedAuthorityEpoch,
    actorType: "user",
    sourceTransport: "internal",
    payload: { authorizationId: input.authorizationId, runId: input.runId,
      projectId: input.expectedProjectId, maxRetries: AUTO_RECOVERY_MAX_RETRIES },
  }, (context) => {
    if (context.projectId !== input.expectedProjectId) throw new Error("Auto-recover Project changed during approval");
    return { projections: projection(input.authorizationId), events: [event("auto.recovery.authorized", input.authorizationId, {
      version: 1, runId: input.runId, maxRetries: AUTO_RECOVERY_MAX_RETRIES,
      allowedKind: "machine_fixable", allowedAction: "retry",
      expiresAt: Date.now() + AUTO_RECOVERY_APPROVAL_TTL_MS,
    })] };
  });
  return input.authorizationId;
}

/** Explicit allowlist, not a permissive needs-human override. */
export function canAutomaticallyRecover(kind: string, classification: Pick<RecoveryClassification, "action">,
  stepMode: boolean): boolean {
  return kind === "machine_fixable" && classification.action === "retry" && !stepMode;
}

/** Reserve ONE resume against the exact still-open pause, atomically with its ledger event.
 * Existing Task/recovery/budget/review checks run again in normal startAuto.
 * A replay never schedules another resume. No pause or Blocker is closed here.
 */
export function consumeAutoRecoveryRetry(input: {
  authorizationId: string;
  runId: string;
  pausedAt: string;
  dispatchId: number | null;
  classification: RecoveryClassification;
}): boolean {
  if (!canAutomaticallyRecover("machine_fixable", input.classification, false)) return false;
  const key = `auto-recovery-retry:${input.authorizationId}:${input.dispatchId}:${input.pausedAt}`;
  const fence = readDomainOperationFence(key);
  const result = executeDomainOperation({
    operationType: "auto.recovery.retry",
    idempotencyKey: key,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { authorizationId: input.authorizationId, runId: input.runId,
      pausedAt: input.pausedAt, dispatchId: input.dispatchId, failureKind: input.classification.failureKind },
  }, (context) => {
    const approval = readApproval(input.authorizationId);
    if (!approval || approval.runId !== input.runId || approval.projectId !== context.projectId ||
        approval.authorityEpoch !== context.resultingAuthorityEpoch || approval.expiresAt <= Date.now() ||
        eventCount(input.authorizationId, "auto.recovery.revoked") > 0 ||
        eventCount(input.authorizationId, "auto.recovery.retry-reserved") >= AUTO_RECOVERY_MAX_RETRIES) {
      throw new Error("Auto-recover approval is absent, expired, revoked, out of scope, or exhausted");
    }
    const pause = readOpenAutoPause();
    if (!pause || pause.blockerKind !== "machine_fixable" || pause.stepMode ||
        pause.pausedAt !== input.pausedAt || (pause.dispatchId ?? null) !== input.dispatchId ||
        readOpenAutoPauseBlockerId() !== null ||
        pause.pauseReason?.split(" | ", 1)[0] !== `recovery:${input.classification.failureKind}/retry`) {
      throw new Error("Auto-recover requires the same mechanical retry pause, without a human Blocker");
    }
    return { projections: projection(input.authorizationId), events: [event("auto.recovery.retry-reserved", input.authorizationId, {
      runId: input.runId, pausedAt: input.pausedAt, dispatchId: input.dispatchId,
      failureKind: input.classification.failureKind,
    })] };
  });
  return result.status === "committed";
}

/** Host stop revokes permission; it does not pretend the operator took this action. */
export function revokeAutoRecovery(authorizationId: string, runId: string): void {
  const key = `auto-recovery-revoke:${authorizationId}`;
  const fence = readDomainOperationFence(key);
  executeDomainOperation({
    operationType: "auto.recovery.revoke", idempotencyKey: key,
    expectedRevision: fence.revision, expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent", sourceTransport: "internal", payload: { authorizationId, runId },
  }, (context) => {
    const approval = readApproval(authorizationId);
    if (!approval || approval.runId !== runId || approval.projectId !== context.projectId) {
      throw new Error("Cannot revoke a different auto-recover run");
    }
    return { projections: projection(authorizationId), events: [event("auto.recovery.revoked", authorizationId, { runId })] };
  });
}
