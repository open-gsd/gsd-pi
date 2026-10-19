import { createHash, randomUUID } from "node:crypto";

import { executeDomainOperation, inspectDomainOperationReceipt, type DomainJsonValue } from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { insertOpenPauseBlocker, resolveOpenPauseBlocker } from "./db/writers/pause-blockers.js";
import { closeAutoPauseForBlocker } from "./db/writers/auto-pauses.js";
import { getDb } from "./db/engine.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { PAUSED_SESSION_KV_KEY, type PausedSessionMetadata } from "./interrupted-session.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import type { AutoPauseBlockerKind, HumanBlockerKind } from "./recovery-policy.js";

const HUMAN_BLOCKER_KINDS = new Set<HumanBlockerKind>([
  "missing_authority",
  "missing_access",
  "external_dependency",
  "consent",
  "ambiguous_intent",
  "subjective_uat",
  "user_limit",
]);

export function isHumanPauseBlockerKind(kind: AutoPauseBlockerKind): boolean {
  return HUMAN_BLOCKER_KINDS.has(kind as HumanBlockerKind);
}

const TASK_PAUSE_UNIT_TYPES = new Set(["execute-task", "replan-task"]);
const SLICE_PAUSE_UNIT_TYPES = new Set([
  "complete-slice", "discuss-slice", "plan-slice", "research-slice", "refine-slice", "replan-slice",
  "run-uat", "reassess-roadmap", "rewrite-docs",
]);
const MILESTONE_PAUSE_UNIT_TYPES = new Set([
  "complete-milestone", "research-milestone", "plan-milestone", "discuss-milestone",
  "validate-milestone", "rewrite-docs",
]);
const SLICE_ID_RE = /^S\d{2,3}$/;
const TASK_ID_RE = /^T\d{2,3}$/;

/**
 * The exact lifecycle row represented by a pause's unit identity. The unit
 * type and slash-delimited id must agree, and the separately persisted
 * milestone id must identify the same milestone. Never fall back to a parent:
 * a missing task/slice lifecycle cannot authorize resolution through an
 * existing slice/milestone lifecycle.
 */
export function findPauseLifecycleId(input: {
  milestoneId?: string | null;
  unitType?: string | null;
  unitId?: string | null;
}): string | null {
  const milestoneId = input.milestoneId ?? "";
  const parts = (input.unitId ?? "").split("/");
  if (
    !milestoneId
    || parts.some((part) => part.length === 0)
    || parts[0] !== milestoneId
    || !MILESTONE_ID_RE.test(parts[0]!)
  ) return null;

  let row: { lifecycle_id: string } | undefined;
  if (
    TASK_PAUSE_UNIT_TYPES.has(input.unitType ?? "")
    && parts.length === 3
    && SLICE_ID_RE.test(parts[1]!)
    && TASK_ID_RE.test(parts[2]!)
  ) {
    row = getDb().prepare(`
      SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = :milestone_id
        AND slice_id = :slice_id AND task_id = :task_id
    `).get({
      ":milestone_id": milestoneId,
      ":slice_id": parts[1],
      ":task_id": parts[2],
    }) as { lifecycle_id: string } | undefined;
  } else if (
    SLICE_PAUSE_UNIT_TYPES.has(input.unitType ?? "")
    && parts.length === 2
    && SLICE_ID_RE.test(parts[1]!)
  ) {
    row = getDb().prepare(`
      SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'slice' AND milestone_id = :milestone_id AND slice_id = :slice_id
    `).get({ ":milestone_id": milestoneId, ":slice_id": parts[1] }) as { lifecycle_id: string } | undefined;
  } else if (MILESTONE_PAUSE_UNIT_TYPES.has(input.unitType ?? "") && parts.length === 1) {
    row = getDb().prepare(`
      SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'milestone' AND milestone_id = :milestone_id
    `).get({ ":milestone_id": milestoneId }) as { lifecycle_id: string } | undefined;
  } else {
    return null;
  }
  return row?.lifecycle_id ?? null;
}

export function openPauseBlockerForSession(input: {
  pause: PausedSessionMetadata & { pauseId: string };
  blockerKind: HumanBlockerKind;
  description: string;
  requestedAction: string;
}): string | null {
  if (!HUMAN_BLOCKER_KINDS.has(input.blockerKind)) return null;
  const lifecycleId = findPauseLifecycleId(input.pause);
  if (!lifecycleId || !input.pause.milestoneId || !input.pause.unitType || !input.pause.unitId) return null;

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
    const blockerId = randomUUID();
    const openedAt = new Date().toISOString();
    const resolutionOwner = input.blockerKind === "external_dependency" ? "external" : "user";
    getDb().prepare(`
      INSERT INTO workflow_blockers (
        blocker_id, project_id, lifecycle_id, blocker_kind, resolution_owner,
        blocker_status, description, requested_action, resolution, opened_at,
        opened_operation_id, opened_project_revision, opened_authority_epoch
      ) VALUES (
        :blocker_id, :project_id, :lifecycle_id, :blocker_kind, :resolution_owner,
        'open', :description, :requested_action, '', :opened_at,
        :operation_id, :project_revision, :authority_epoch
      )
    `).run({
      ":blocker_id": blockerId,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId,
      ":blocker_kind": input.blockerKind,
      ":resolution_owner": resolutionOwner,
      ":description": input.description.trim(),
      ":requested_action": input.requestedAction.trim(),
      ":opened_at": openedAt,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
    getDb().prepare(`
      INSERT INTO auto_pause_blocker_links (
        blocker_id, pause_id, lifecycle_id, milestone_id, unit_type, unit_id, created_at
      ) VALUES (:blocker_id, :pause_id, :lifecycle_id, :milestone_id, :unit_type, :unit_id, :created_at)
    `).run({
      ":blocker_id": blockerId,
      ":pause_id": input.pause.pauseId,
      ":lifecycle_id": lifecycleId,
      ":milestone_id": input.pause.milestoneId,
      ":unit_type": input.pause.unitType,
      ":unit_id": input.pause.unitId,
      ":created_at": openedAt,
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
    getDb().prepare(`
      UPDATE runtime_kv SET value_json = :value_json, updated_at = :updated_at
      WHERE scope = 'global' AND scope_id = '' AND key = :key
    `).run({
      ":value_json": JSON.stringify(metadata),
      ":updated_at": openedAt,
      ":key": PAUSED_SESSION_KV_KEY,
    });
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
 */
export function resolvePauseBlockerRow(input: {
  blockerId: string;
  disposition: "resolved" | "dismissed";
  resolution: string;
  idempotencyKey: string;
}): boolean {
  let resolved = false;
  executeDomainOperation(
    pauseBlockerRequest("pause.blocker.resolve", input.idempotencyKey, {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
    }),
    (context) => {
      const settled = resolveOpenPauseBlocker(context, {
        blockerId: input.blockerId,
        disposition: input.disposition,
        resolution: input.resolution,
      });
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

export type ResolveAutoPauseBlockerFailure =
  | "blocker-not-found"
  | "blocker-not-open"
  | "no-associated-pause"
  | "association-mismatch"
  | "unsupported-blocker-kind";

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
    || !HUMAN_BLOCKER_KINDS.has(association.blocker_kind as HumanBlockerKind)
    || association.resolution_owner !== "user"
    || findPauseLifecycleId(metadata) !== association.lifecycle_id
  ) return { resolved: false, failure: "association-mismatch" };

  const payload = {
    blockerId: input.blockerId,
    pauseId: association.pause_id,
    lifecycleId: association.lifecycle_id,
    rationale: input.rationale.trim(),
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
    const now = new Date().toISOString();
    const updated = getDb().prepare(`
      UPDATE workflow_blockers
      SET blocker_status = 'resolved', resolution = :rationale, resolved_at = :resolved_at,
          resolved_operation_id = :operation_id, resolved_project_revision = :project_revision,
          resolved_authority_epoch = :authority_epoch
      WHERE blocker_id = :blocker_id AND project_id = :project_id AND blocker_status = 'open'
    `).run({
      ":rationale": input.rationale.trim(),
      ":resolved_at": now,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":blocker_id": input.blockerId,
      ":project_id": context.projectId,
    });
    if (Number((updated as { changes?: unknown }).changes ?? 0) !== 1) {
      throw new Error("Auto-pause blocker is no longer open");
    }
    getDb().prepare(`
      UPDATE auto_pause_blocker_links SET resolved_at = :resolved_at
      WHERE blocker_id = :blocker_id AND resolved_at IS NULL
    `).run({ ":resolved_at": now, ":blocker_id": input.blockerId });
    getDb().prepare(`
      DELETE FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key
    `).run({ ":key": PAUSED_SESSION_KV_KEY });
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
}): ResolveAutoPauseBlockerResult {
  if (!input.blockerId.trim()) throw new Error("blockerId must not be blank");
  if (!input.rationale.trim()) throw new Error("rationale must not be blank");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("expectedRevision must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.expectedAuthorityEpoch) || input.expectedAuthorityEpoch < 0) {
    throw new Error("expectedAuthorityEpoch must be a non-negative safe integer");
  }

  // Older builds bound pauses in runtime_kv; preserve that exact association.
  const legacyLink = getDb().prepare(
    `SELECT 1 FROM auto_pause_blocker_links WHERE blocker_id = :blocker_id`,
  ).get({ ":blocker_id": input.blockerId });
  if (legacyLink) return resolveLegacyAutoPauseBlockerById(input);

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
        },
      },
      (context) => {
        const db = getDb();
        const authority = db.prepare(
          `SELECT project_id FROM project_authority WHERE singleton = 1`,
        ).get() as { project_id: string };
        const blocker = db.prepare(
          `SELECT project_id, lifecycle_id, blocker_kind, resolution_owner, blocker_status
           FROM workflow_blockers WHERE blocker_id = :blocker_id`,
        ).get({ ":blocker_id": input.blockerId }) as {
          project_id: string;
          lifecycle_id: string;
          blocker_kind: AutoPauseBlockerKind;
          resolution_owner: string;
          blocker_status: string;
        } | undefined;
        const pauses = db.prepare(
          `SELECT scope, blocker_kind, milestone_id, unit_type, unit_id
           FROM auto_pauses WHERE blocker_id = :blocker_id AND closed_at IS NULL LIMIT 2`,
        ).all({ ":blocker_id": input.blockerId }) as Array<{
          scope: string;
          blocker_kind: AutoPauseBlockerKind;
          milestone_id: string | null;
          unit_type: string | null;
          unit_id: string | null;
        }>;
        const pause = pauses.length === 1 ? pauses[0] : undefined;

        let failure: ResolveAutoPauseBlockerFailure | undefined;
        if (!blocker || blocker.project_id !== authority.project_id) {
          failure = "blocker-not-found";
        } else if (blocker.blocker_status !== "open") {
          failure = "blocker-not-open";
        } else if (pauses.length === 0) {
          failure = "no-associated-pause";
        } else if (pauses.length !== 1 || pause === undefined) {
          failure = "association-mismatch";
        } else if (
          !isHumanPauseBlockerKind(blocker.blocker_kind)
          || !isHumanPauseBlockerKind(pause.blocker_kind)
          || blocker.resolution_owner !== "user"
        ) {
          failure = "unsupported-blocker-kind";
        } else {
          const expectedLifecycleId = findPauseLifecycleId({
            milestoneId: pause.milestone_id,
            unitType: pause.unit_type,
            unitId: pause.unit_id,
          });
          if (
            blocker.blocker_kind !== pause.blocker_kind
            || expectedLifecycleId === null
            || blocker.lifecycle_id !== expectedLifecycleId
          ) {
            failure = "association-mismatch";
          }
        }

        if (failure) throw new ResolveAutoPauseRefusal({ resolved: false, failure });

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
