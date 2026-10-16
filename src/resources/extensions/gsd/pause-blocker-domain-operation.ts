// Project/App: gsd-pi
// File Purpose: The workflow_blockers row of a human pause (ADR-046): the
// seven human blocker kinds are human-only, so a pause for one of them opens a
// blocker for the paused item, and the resolution of the pause resolves it.
// A machine_fixable or user_request pause opens no blocker.

import { createHash } from "node:crypto";

import {
  executeDomainOperation,
  type DomainJsonValue,
} from "./db/domain-operation.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { insertOpenPauseBlocker, resolveOpenPauseBlocker } from "./db/writers/pause-blockers.js";
import { closeAutoPauseForBlocker } from "./db/writers/auto-pauses.js";
import { getDb } from "./gsd-db.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import type { AutoPauseBlockerKind } from "./recovery-policy.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";

/** The blocker kinds a pause opens a workflow_blockers row for. */
const HUMAN_PAUSE_BLOCKER_KINDS: ReadonlySet<string> = new Set([
  "missing_authority",
  "missing_access",
  "external_dependency",
  "consent",
  "ambiguous_intent",
  "subjective_uat",
  "user_limit",
]);

export function isHumanPauseBlockerKind(kind: AutoPauseBlockerKind): boolean {
  return HUMAN_PAUSE_BLOCKER_KINDS.has(kind);
}

// Keep this aligned with the canonical auto/run-hook lifecycle-bearing units:
// other current-unit labels do not prove one of these three workflow rows.
const TASK_PAUSE_UNIT_TYPES = new Set(["execute-task"]);
const SLICE_PAUSE_UNIT_TYPES = new Set(["complete-slice", "plan-slice"]);
const MILESTONE_PAUSE_UNIT_TYPES = new Set(["complete-milestone", "research-milestone"]);
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
  const db = getDb();
  const unitType = input.unitType ?? "";
  const parts = (input.unitId ?? "").split("/");
  if (
    !input.milestoneId
    || parts.some((part) => part.length === 0)
    || parts[0] !== input.milestoneId
    || !MILESTONE_ID_RE.test(parts[0])
  ) return null;

  let row: { lifecycle_id: string } | undefined;
  if (
    TASK_PAUSE_UNIT_TYPES.has(unitType)
    && parts.length === 3
    && SLICE_ID_RE.test(parts[1])
    && TASK_ID_RE.test(parts[2])
  ) {
    row = db.prepare(
      `SELECT lifecycle_id FROM workflow_item_lifecycles
       WHERE item_kind = 'task' AND milestone_id = :milestone_id
         AND slice_id = :slice_id AND task_id = :task_id`,
    ).get({
      ":milestone_id": parts[0],
      ":slice_id": parts[1],
      ":task_id": parts[2],
    }) as { lifecycle_id: string } | undefined;
  } else if (
    SLICE_PAUSE_UNIT_TYPES.has(unitType)
    && parts.length === 2
    && SLICE_ID_RE.test(parts[1])
  ) {
    row = db.prepare(
      `SELECT lifecycle_id FROM workflow_item_lifecycles
       WHERE item_kind = 'slice' AND milestone_id = :milestone_id AND slice_id = :slice_id`,
    ).get({
      ":milestone_id": parts[0],
      ":slice_id": parts[1],
    }) as { lifecycle_id: string } | undefined;
  } else if (MILESTONE_PAUSE_UNIT_TYPES.has(unitType) && parts.length === 1) {
    row = db.prepare(
      `SELECT lifecycle_id FROM workflow_item_lifecycles
       WHERE item_kind = 'milestone' AND milestone_id = :milestone_id`,
    ).get({ ":milestone_id": parts[0] }) as { lifecycle_id: string } | undefined;
  } else {
    return null;
  }
  return row ? String(row.lifecycle_id) : null;
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
          payload: { blockerId, blockerKind: input.blockerKind } satisfies DomainJsonValue,
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

class ResolveAutoPauseRefusal extends Error {
  constructor(readonly result: ResolveAutoPauseBlockerResult) {
    super(`auto-pause blocker resolution refused: ${result.failure}`);
    this.name = "ResolveAutoPauseRefusal";
  }
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

  let outcome: ResolveAutoPauseBlockerResult | null = null;
  let operation: ReturnType<typeof executeDomainOperation>;
  try {
    operation = executeDomainOperation(
      {
        operationType: "pause.blocker.resolve.by-id",
        idempotencyKey: resolveAutoPauseOperationKey(input.invocation),
        expectedRevision: input.expectedRevision,
        expectedAuthorityEpoch: input.expectedAuthorityEpoch,
        actorType: input.invocation.actorType,
        ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
        sourceTransport: input.invocation.sourceTransport,
        ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
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
           FROM auto_pauses WHERE blocker_id = :blocker_id AND closed_at IS NULL`,
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
