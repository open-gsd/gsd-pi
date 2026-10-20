import { createHash } from "node:crypto";

import { executeDomainOperation, inspectDomainOperationReceipt, type DomainJsonValue } from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { insertOpenPauseBlocker, insertPauseBlockerLink, resolveOpenPauseBlocker, resolvePauseBlockerLink } from "./db/writers/pause-blockers.js";
import { deleteRuntimeKv, setRuntimeKv } from "./db/runtime-kv.js";
import { closeAutoPause, closeAutoPauseForBlocker, readOpenAutoPauseBlockerId } from "./db/writers/auto-pauses.js";
import { getDb } from "./db/engine.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { PAUSED_SESSION_KV_KEY, type PausedSessionMetadata } from "./interrupted-session.js";
import type { AutoPauseBlockerKind, HumanBlockerKind } from "./recovery-policy.js";
import {
  classifyAutoPauseBlockerResolution, findPauseLifecycleIdIn, isHumanPauseBlockerKind,
  type AutoPauseBlockerResolutionInspection, type ResolveAutoPauseBlockerFailure,
} from "./pause-blocker-inspection.js";
export { isHumanPauseBlockerKind } from "./pause-blocker-inspection.js";
export type { AutoPauseBlockerResolutionInspection, ResolveAutoPauseBlockerFailure } from "./pause-blocker-inspection.js";

/** Existing internal callers use the bound engine; file inspection never does. */
export function findPauseLifecycleId(input: {
  milestoneId?: string | null;
  unitType?: string | null;
  unitId?: string | null;
}): string | null {
  return findPauseLifecycleIdIn(getDb(), input);
}

export function openPauseBlockerForSession(input: {
  pause: PausedSessionMetadata & { pauseId: string };
  blockerKind: HumanBlockerKind;
  description: string;
  requestedAction: string;
}): string | null {
  if (!isHumanPauseBlockerKind(input.blockerKind)) return null;
  const lifecycleId = findPauseLifecycleId(input.pause);
  if (!lifecycleId || !input.pause.milestoneId || !input.pause.unitType || !input.pause.unitId) return null;
  const { milestoneId, unitType, unitId } = input.pause;

  const operationType = "pause.blocker.open";
  const idempotencyKey = `pause-blocker-open:${input.pause.pauseId}`;
  const fence = readDomainOperationFence(idempotencyKey);
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: {
      pauseId: input.pause.pauseId,
      lifecycleId,
      blockerKind: input.blockerKind,
      description: input.description,
      requestedAction: input.requestedAction,
    },
  }, (context) => {
    const { blockerId } = insertOpenPauseBlocker(context, {
      lifecycleId,
      blockerKind: input.blockerKind,
      resolutionOwner: input.blockerKind === "external_dependency" ? "external" : "user",
      description: input.description,
      requestedAction: input.requestedAction,
    });
    insertPauseBlockerLink(context, {
      blockerId,
      pauseId: input.pause.pauseId,
      lifecycleId,
      milestoneId,
      unitType,
      unitId,
    });
    const row = getDb().prepare(`
      SELECT value_json FROM runtime_kv
      WHERE scope = 'global' AND scope_id = '' AND key = :key
    `).get({ ":key": PAUSED_SESSION_KV_KEY }) as { value_json: string } | undefined;
    if (!row) throw new Error("Paused session metadata disappeared before blocker association");
    const metadata = JSON.parse(row.value_json) as PausedSessionMetadata;
    if (metadata.pauseId !== input.pause.pauseId) {
      throw new Error("Paused session changed before blocker association");
    }
    metadata.pauseBlockerId = blockerId;
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, metadata);
    return {
      events: [{
        eventType: "pause.blocker.opened",
        entityType: "pause",
        entityId: blockerId,
        payload: {
          blockerId,
          pauseId: input.pause.pauseId,
          blockerKind: input.blockerKind,
          reusedExistingBlocker: false,
        },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `pause-blocker/${blockerId}`,
        projectionKind: "pause-blocker",
        rendererVersion: "1",
      }],
    };
  });
  const row = getDb().prepare(`
    SELECT blocker_id FROM auto_pause_blocker_links WHERE pause_id = :pause_id
  `).get({ ":pause_id": input.pause.pauseId }) as { blocker_id: string } | undefined;
  return row?.blocker_id ?? null;
}

function pauseBlockerRequest(
  operationType: string,
  idempotencyKey: string,
  payload: DomainJsonValue,
) {
  const fence = readDomainOperationFence(idempotencyKey);
  return {
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload,
  };
}

/**
 * Open the workflow_blockers row of a human pause. The paused item must have a
 * lifecycle row; a pause of an item the lifecycle graph does not know (a
 * project-setup unit, a pause with no active unit and no milestone) opens no
 * blocker and the pause row alone records it.
 */
export function openPauseBlockerRow(input: {
  lifecycleId: string;
  blockerKind: AutoPauseBlockerKind;
  description: string;
  requestedAction: string;
  idempotencyKey: string;
}): { blockerId: string } {
  if (!isHumanPauseBlockerKind(input.blockerKind)) {
    throw new Error(`${input.blockerKind} is not a human blocker kind and opens no workflow_blockers row`);
  }
  let blockerId = "";
  executeDomainOperation(
    pauseBlockerRequest("pause.blocker.open", input.idempotencyKey, {
      lifecycleId: input.lifecycleId,
      blockerKind: input.blockerKind,
      description: input.description,
      requestedAction: input.requestedAction,
    }),
    (context) => {
      const opened = insertOpenPauseBlocker(context, {
        lifecycleId: input.lifecycleId,
        blockerKind: input.blockerKind,
        description: input.description,
        requestedAction: input.requestedAction,
      });
      blockerId = opened.blockerId;
      return {
        events: [{
          eventType: "pause.blocker.opened",
          entityType: "pause",
          entityId: blockerId,
          payload: { blockerId, blockerKind: input.blockerKind, reusedExistingBlocker: false } satisfies DomainJsonValue,
          destinations: ["projection"],
        }],
        // No renderer is registered for this kind, so the projection worker
        // skips it; the domain operation protocol requires a projection target.
        projections: [{
          projectionKey: `pause-blocker/${blockerId}`,
          projectionKind: "pause-blocker",
          rendererVersion: "1",
        }],
      };
    },
  );
  return { blockerId };
}

/**
 * Resolve (or dismiss) the open workflow_blockers row of a pause. An unknown
 * or already-resolved blocker resolves nothing and false comes back.
 * Internal resume/discard can also close the current scope's linked pause
 * atomically; that path throws if its association can no longer be resolved.
 */
export function resolvePauseBlockerRow(input: {
  blockerId: string;
  disposition: "resolved" | "dismissed";
  resolution: string;
  idempotencyKey: string;
  closeCurrentPause?: boolean;
}): boolean {
  let resolved = false;
  executeDomainOperation(
    pauseBlockerRequest("pause.blocker.resolve", input.idempotencyKey, {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
      ...(input.closeCurrentPause ? { closeCurrentPause: true } : {}),
    }),
    (context) => {
      // Resume/discard owns this scope's persisted association, including
      // pre-upgrade pauses linked to a parent lifecycle.
      if (input.closeCurrentPause && readOpenAutoPauseBlockerId() !== input.blockerId) {
        throw new Error("Current pause/blocker association changed");
      }
      const settled = resolveOpenPauseBlocker(context, {
        blockerId: input.blockerId,
        disposition: input.disposition,
        resolution: input.resolution,
      });
      if (input.closeCurrentPause) {
        if (!settled.resolved) throw new Error("Current pause blocker is no longer open");
        closeAutoPause();
      }
      resolved = settled.resolved;
      return {
        events: [{
          eventType: "pause.blocker.resolved",
          entityType: "pause",
          entityId: input.blockerId,
          payload: { blockerId: input.blockerId, disposition: input.disposition, resolved } satisfies DomainJsonValue,
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `pause-blocker/${input.blockerId}`,
          projectionKind: "pause-blocker",
          rendererVersion: "1",
        }],
      };
    },
  );
  return resolved;
}

export interface ResolveAutoPauseBlockerResult {
  /** `true` when the exact blocker and its associated open pause both closed. */
  resolved: boolean;
  /** Set only when `resolved` is false; why the clear-only operation refused. */
  failure?: ResolveAutoPauseBlockerFailure;
  /** The worker scope of the human-owned pause that closed. */
  scope?: string;
}

const RESOLVE_AUTO_PAUSE_IDENTITY_VERSION = "resolve-auto-pause-blocker:v1";
const WORKFLOW_MCP_RESOLVE_KEY_PREFIX = "mcp:gsd_resolve_blocker:";

/**
 * Namespace the caller's stable retry identity at the workflow/domain
 * boundary. Keeping this derivation here makes it authoritative for packaged
 * MCP, native Pi-tool, and direct bridge callers alike. Only the digest is
 * persisted; transport metadata never appears in the durable key.
 */
function resolveAutoPauseOperationKey(invocation: ExecutionInvocation): string {
  if (!invocation.idempotencyKey.trim()) throw new Error("idempotencyKey must not be blank");
  if (!invocation.sourceTransport.trim()) throw new Error("sourceTransport must not be blank");
  if (!invocation.actorType.trim()) throw new Error("actorType must not be blank");
  const identity = JSON.stringify({
    version: RESOLVE_AUTO_PAUSE_IDENTITY_VERSION,
    tool: "gsd_resolve_blocker",
    sourceTransport: invocation.sourceTransport,
    actorType: invocation.actorType,
    actorId: invocation.actorId ?? null,
    stableInput: invocation.idempotencyKey,
  });
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `${RESOLVE_AUTO_PAUSE_IDENTITY_VERSION}:sha256:${digest}`;
}

/**
 * Before private MCP traces were hashed, workflow MCP persisted its raw
 * stable retry identity as the trace. Match that representation only when a
 * receipt with the same durable key already has the former trace; new writes
 * continue to use the caller's hashed trace.
 */
function replayCompatibleTraceId(
  operationKey: string,
  invocation: ExecutionInvocation,
): string | undefined {
  if (
    invocation.sourceTransport !== "workflow-mcp"
    || !invocation.idempotencyKey.startsWith(WORKFLOW_MCP_RESOLVE_KEY_PREFIX)
  ) {
    return invocation.traceId;
  }
  const formerRawTrace = invocation.idempotencyKey.slice(WORKFLOW_MCP_RESOLVE_KEY_PREFIX.length);
  if (!formerRawTrace || invocation.traceId === formerRawTrace) return invocation.traceId;
  const receipt = getDb().prepare(`
    SELECT trace_id
    FROM workflow_operations
    WHERE operation_type = 'pause.blocker.resolve.by-id'
      AND idempotency_key = :idempotency_key
  `).get({ ":idempotency_key": operationKey });
  return receipt?.["trace_id"] === formerRawTrace ? formerRawTrace : invocation.traceId;
}

/** Internal bound-connection preflight. Public native inspection uses the read-only file reader. */
export function readAutoPauseBlockerResolution(blockerId: string): AutoPauseBlockerResolutionInspection {
  return classifyAutoPauseBlockerResolution(getDb(), blockerId);
}

function autoPauseCallerOwnsBlocker(blockerId: string, invocation: ExecutionInvocation): boolean {
  const row = getDb().prepare(`SELECT resolution_owner FROM workflow_blockers WHERE blocker_id = :id`)
    .get({ ":id": blockerId });
  return !row || row["resolution_owner"] === invocation.actorType;
}

function requireExpectedPauseProject(expectedProjectId?: string): void {
  if (expectedProjectId !== undefined) {
    const authority = getDb().prepare(`SELECT project_id FROM project_authority WHERE singleton = 1`).get();
    if (!expectedProjectId || authority?.["project_id"] !== expectedProjectId) {
      throw new Error("Project ID changed; inspect the intended Project again before resolving.");
    }
  }
}

function requireAutoPauseResolutionEligibility(
  blockerId: string, invocation: ExecutionInvocation, expectedProjectId?: string,
): void {
  requireExpectedPauseProject(expectedProjectId);
  // The same explicit-reader classifier as native inspection, now in the write transaction.
  const observed = classifyAutoPauseBlockerResolution(getDb(), blockerId);
  if (!autoPauseCallerOwnsBlocker(blockerId, invocation)) {
    throw new ResolveAutoPauseRefusal({ resolved: false, failure: "owner-mismatch" });
  }
  if (!observed.eligible) {
    throw new ResolveAutoPauseRefusal({ resolved: false, failure: observed.failure });
  }
}

class ResolveAutoPauseRefusal extends Error {
  readonly result: ResolveAutoPauseBlockerResult;

  constructor(result: ResolveAutoPauseBlockerResult) {
    super(`auto-pause blocker resolution refused: ${result.failure}`);
    this.name = "ResolveAutoPauseRefusal";
    this.result = result;
  }
}

/** Resolve an exact association persisted before pauses moved to auto_pauses. */
function resolveLegacyAutoPauseBlockerById(input: {
  blockerId: string;
  rationale: string;
  invocation: ExecutionInvocation;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  /** Optional for existing internal callers; native approvals always pin the Project ID. */
  expectedProjectId?: string;
}): ResolveAutoPauseBlockerResult {
  if (!input.rationale.trim()) throw new Error("rationale must not be blank");
  const association = getDb().prepare(`
    SELECT link.pause_id, link.lifecycle_id, link.milestone_id, link.unit_type, link.unit_id,
           link.resolved_at, blocker.blocker_kind, blocker.blocker_status, blocker.resolution_owner
    FROM auto_pause_blocker_links link
    JOIN workflow_blockers blocker ON blocker.blocker_id = link.blocker_id
      AND blocker.lifecycle_id = link.lifecycle_id
    WHERE link.blocker_id = :blocker_id
  `).get({ ":blocker_id": input.blockerId }) as {
    pause_id: string;
    lifecycle_id: string;
    milestone_id: string;
    unit_type: string;
    unit_id: string;
    resolved_at: string | null;
    blocker_kind: string;
    blocker_status: string;
    resolution_owner: string;
  } | undefined;
  if (!association) return { resolved: false, failure: "blocker-not-found" };
  const operationType = "pause.blocker.resolve.by-id";
  const idempotencyKey = resolveAutoPauseOperationKey(input.invocation);
  const traceId = replayCompatibleTraceId(idempotencyKey, input.invocation);
  const prior = inspectDomainOperationReceipt(operationType, idempotencyKey);
  if (prior) {
    executeDomainOperation({
      operationType,
      idempotencyKey,
      expectedRevision: input.expectedRevision,
      expectedAuthorityEpoch: input.expectedAuthorityEpoch,
      actorType: input.invocation.actorType,
      ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
      sourceTransport: input.invocation.sourceTransport,
      traceId,
      turnId: input.invocation.turnId,
      payload: {
        blockerId: input.blockerId,
        pauseId: association.pause_id,
        lifecycleId: association.lifecycle_id,
        rationale: input.rationale.trim(),
        ...(input.expectedProjectId !== undefined ? { expectedProjectId: input.expectedProjectId } : {}),
      },
    }, () => { throw new Error("Replayed pause blocker operation unexpectedly mutated"); });
    return { resolved: true };
  }
  if (association.blocker_status !== "open") return { resolved: false, failure: "blocker-not-open" };
  const paused = getDb().prepare(`
    SELECT value_json FROM runtime_kv
    WHERE scope = 'global' AND scope_id = '' AND key = :key
  `).get({ ":key": PAUSED_SESSION_KV_KEY }) as { value_json: string } | undefined;
  if (!paused) return { resolved: false, failure: "no-associated-pause" };
  let metadata: PausedSessionMetadata;
  try {
    metadata = JSON.parse(paused.value_json) as PausedSessionMetadata;
  } catch {
    return { resolved: false, failure: "association-mismatch" };
  }
  if (
    metadata.pauseId !== association.pause_id
    || metadata.pauseBlockerId !== input.blockerId
    || metadata.milestoneId !== association.milestone_id
    || metadata.unitType !== association.unit_type
    || metadata.unitId !== association.unit_id
    || (metadata.blockerKind !== undefined && metadata.blockerKind !== association.blocker_kind)
    || !isHumanPauseBlockerKind(association.blocker_kind as AutoPauseBlockerKind)
    || association.resolution_owner !== "user"
    || findPauseLifecycleId(metadata) !== association.lifecycle_id
  ) return { resolved: false, failure: "association-mismatch" };

  const payload = {
    blockerId: input.blockerId,
    pauseId: association.pause_id,
    lifecycleId: association.lifecycle_id,
    rationale: input.rationale.trim(),
    ...(input.expectedProjectId !== undefined ? { expectedProjectId: input.expectedProjectId } : {}),
  };
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: input.expectedRevision,
    expectedAuthorityEpoch: input.expectedAuthorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    traceId,
    turnId: input.invocation.turnId,
    payload,
  }, (context) => {
    requireAutoPauseResolutionEligibility(input.blockerId, input.invocation, input.expectedProjectId);
    const current = getDb().prepare(`
      SELECT value_json FROM runtime_kv
      WHERE scope = 'global' AND scope_id = '' AND key = :key
    `).get({ ":key": PAUSED_SESSION_KV_KEY }) as { value_json: string } | undefined;
    if (!current) throw new Error("No associated paused session");
    const liveMetadata = JSON.parse(current.value_json) as PausedSessionMetadata;
    if (
      liveMetadata.pauseId !== association.pause_id
      || liveMetadata.pauseBlockerId !== input.blockerId
      || (liveMetadata.blockerKind !== undefined && liveMetadata.blockerKind !== association.blocker_kind)
      || findPauseLifecycleId(liveMetadata) !== association.lifecycle_id
    ) throw new Error("Pause/blocker lifecycle association changed");
    const updated = resolveOpenPauseBlocker(context, {
      blockerId: input.blockerId,
      disposition: "resolved",
      resolution: input.rationale,
    });
    if (!updated.resolved) {
      throw new Error("Auto-pause blocker is no longer open");
    }
    resolvePauseBlockerLink(context, input.blockerId);
    deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
    return {
      events: [{
        eventType: "pause.blocker.resolved",
        entityType: "pause",
        entityId: input.blockerId,
        payload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `pause-blocker/${input.blockerId}`,
        projectionKind: "pause-blocker",
        rendererVersion: "1",
      }],
    };
  });
  return { resolved: true };
}

/**
 * Resolve one named workflow_blockers row of a human auto-pause and close its
 * exact associated open `auto_pauses` row, atomically, in a single
 * `pause.blocker.resolve.by-id` Domain Operation. This is the clear-only
 * public primitive `gsd_resolve_blocker` uses for an auto-pause blocker: it
 * never starts auto, authorizes a retry, settles an Attempt, or records task
 * success — `gsd_task_recovery_resume` remains the separate operation for
 * that.
 *
 * Refuses without changing blocker/pause state when the blocker is absent or
 * closed, or its pause association does not prove the same project, exact
 * lifecycle, supported human-owned kind, and open pause. Stale revision/epoch
 * fences also fail without a durable attempt. Every refusal throws from the
 * Domain Operation callback so its provisional operation row and all
 * associated work roll back; only committed success is replayable.
 */
export function resolveAutoPauseBlockerById(input: {
  blockerId: string;
  rationale: string;
  invocation: ExecutionInvocation;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  /** Optional for existing internal callers; native approvals always pin the Project ID. */
  expectedProjectId?: string;
}): ResolveAutoPauseBlockerResult {
  if (!input.blockerId.trim()) throw new Error("blockerId must not be blank");
  if (!input.rationale.trim()) throw new Error("rationale must not be blank");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.expectedAuthorityEpoch) || input.expectedAuthorityEpoch < 0) {
    throw new Error("expectedAuthorityEpoch must be a non-negative safe integer");
  }

  // Caller provenance is host-owned. Rationale (including model-supplied human
  // claims) never changes ownership, even for a replay of an older receipt.
  if (!autoPauseCallerOwnsBlocker(input.blockerId, input.invocation)) {
    return { resolved: false, failure: "owner-mismatch" };
  }

  requireExpectedPauseProject(input.expectedProjectId);

  // Older builds bound pauses in runtime_kv; preserve that exact association.
  const legacyLink = getDb().prepare(
    `SELECT 1 FROM auto_pause_blocker_links WHERE blocker_id = :blocker_id`,
  ).get({ ":blocker_id": input.blockerId });
  if (legacyLink) {
    try {
      return resolveLegacyAutoPauseBlockerById(input);
    } catch (error) {
      if (error instanceof ResolveAutoPauseRefusal) return error.result;
      throw error;
    }
  }

  const operationKey = resolveAutoPauseOperationKey(input.invocation);
  const traceId = replayCompatibleTraceId(operationKey, input.invocation);
  let outcome: ResolveAutoPauseBlockerResult | null = null;
  let operation: ReturnType<typeof executeDomainOperation>;
  try {
    operation = executeDomainOperation(
      {
        operationType: "pause.blocker.resolve.by-id",
        idempotencyKey: operationKey,
        expectedRevision: input.expectedRevision,
        expectedAuthorityEpoch: input.expectedAuthorityEpoch,
        actorType: input.invocation.actorType,
        ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
        sourceTransport: input.invocation.sourceTransport,
        ...(traceId ? { traceId } : {}),
        ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
        payload: {
          blockerId: input.blockerId,
          rationale: input.rationale,
          ...(input.expectedProjectId !== undefined ? { expectedProjectId: input.expectedProjectId } : {}),
        },
      },
      (context) => {
        requireAutoPauseResolutionEligibility(input.blockerId, input.invocation, input.expectedProjectId);
        const settled = resolveOpenPauseBlocker(context, {
          blockerId: input.blockerId,
          disposition: "resolved",
          resolution: input.rationale,
        });
        if (!settled.resolved) {
          throw new Error(
            `pause-blocker ${input.blockerId} was not open when the Domain Operation reached it ` +
            `(concurrent resolution) — refusing to close its pause.`,
          );
        }
        const closed = closeAutoPauseForBlocker(context, input.blockerId);
        if (!closed.closed) {
          throw new Error(
            `pause-blocker ${input.blockerId} has no open pause bound to it inside the Domain Operation ` +
            `transaction (concurrent close) — refusing to leave the blocker resolved with no pause closed.`,
          );
        }
        outcome = { resolved: true, scope: closed.scope ?? undefined };
        return {
          events: [{
            eventType: "pause.blocker.resolved",
            entityType: "pause",
            entityId: input.blockerId,
            payload: {
              blockerId: input.blockerId,
              disposition: "resolved",
              resolved: true,
              scope: closed.scope,
            } satisfies DomainJsonValue,
            destinations: ["projection"],
          }],
          projections: [{
            projectionKey: `pause-blocker/${input.blockerId}`,
            projectionKind: "pause-blocker",
            rendererVersion: "1",
          }],
        };
      },
    );
  } catch (error) {
    if (error instanceof ResolveAutoPauseRefusal) return error.result;
    throw error;
  }

  if (operation.status === "replayed") {
    const event = getDb().prepare(
      `SELECT event_type, payload_json
       FROM workflow_domain_events
       WHERE operation_id = :operation_id AND event_index = 0`,
    ).get({ ":operation_id": operation.operationId }) as {
      event_type: string;
      payload_json: string;
    } | undefined;
    if (!event) throw new Error(`resolve operation ${operation.operationId} has no outcome event`);
    const payload = JSON.parse(event.payload_json) as {
      resolved?: unknown;
      failure?: unknown;
      scope?: unknown;
    };
    return {
      resolved: true,
      ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    };
  }
  if (!outcome) throw new Error(`resolve operation ${operation.operationId} produced no outcome`);
  return outcome;
}
