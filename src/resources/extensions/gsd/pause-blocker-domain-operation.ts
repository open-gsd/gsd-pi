import { createHash, randomUUID } from "node:crypto";

import { executeDomainOperation, inspectDomainOperationReceipt } from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { getDb } from "./db/engine.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { PAUSED_SESSION_KV_KEY, type PausedSessionMetadata } from "./interrupted-session.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import type { HumanBlockerKind } from "./recovery-policy.js";

const HUMAN_BLOCKER_KINDS = new Set<HumanBlockerKind>([
  "missing_authority",
  "missing_access",
  "external_dependency",
  "consent",
  "ambiguous_intent",
  "subjective_uat",
  "user_limit",
]);

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
    const resolutionOwner = input.blockerKind === "external_dependency" ? "external" : "user";
    const existing = getDb().prepare(`
      SELECT blocker.blocker_id FROM workflow_blockers blocker
      WHERE blocker.lifecycle_id = :lifecycle_id
        AND blocker.blocker_kind = :blocker_kind
        AND blocker.resolution_owner = :resolution_owner
        AND blocker.blocker_status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM auto_pause_blocker_links link WHERE link.blocker_id = blocker.blocker_id
        )
      ORDER BY blocker.opened_at DESC, blocker.blocker_id
      LIMIT 1
    `).get({
      ":lifecycle_id": lifecycleId,
      ":blocker_kind": input.blockerKind,
      ":resolution_owner": resolutionOwner,
    }) as { blocker_id: string } | undefined;
    const blockerId = existing?.blocker_id ?? randomUUID();
    const openedAt = new Date().toISOString();
    if (!existing) {
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
    }
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
          reusedExistingBlocker: Boolean(existing),
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

export type ResolveAutoPauseBlockerResult = {
  resolved: boolean;
  failure?: "blocker-not-found" | "blocker-not-open" | "no-associated-pause" | "association-mismatch";
};

function pauseResolutionKey(invocation: ExecutionInvocation): string {
  const identity = JSON.stringify({
    version: "resolve-auto-pause-blocker:v1",
    tool: "gsd_resolve_blocker",
    sourceTransport: invocation.sourceTransport,
    actorType: invocation.actorType,
    actorId: invocation.actorId ?? null,
    stableInput: invocation.idempotencyKey,
  });
  return `resolve-auto-pause-blocker:v1:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function resolveAutoPauseBlockerById(input: {
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
  const idempotencyKey = pauseResolutionKey(input.invocation);
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
      traceId: input.invocation.traceId,
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
    || !HUMAN_BLOCKER_KINDS.has(association.blocker_kind as HumanBlockerKind)
    || association.resolution_owner !== (association.blocker_kind === "external_dependency" ? "external" : "user")
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
    traceId: input.invocation.traceId,
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
