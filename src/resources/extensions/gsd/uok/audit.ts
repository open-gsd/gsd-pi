// gsd-pi UOK Audit Events and DB-First Projection Writes

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { isStaleWrite } from "../auto/turn-epoch.js";
import { withFileLockSync } from "../file-lock.js";
import { gsdRoot } from "../paths.js";
import { isDbAvailable, insertAuditEvent } from "../gsd-db.js";
import { CURRENT_UOK_CONTRACT_VERSION, validateAuditEvent, type AuditEventEnvelope } from "./contracts.js";
import { isUnifiedAuditEnabled } from "./audit-toggle.js";
import {
  lifecycleShadowErrorHash,
  type LifecycleShadowObservation,
} from "../lifecycle-shadow-observation.js";

function auditLogPath(basePath: string): string {
  return join(gsdRoot(basePath), "audit", "events.jsonl");
}

function appendLockedJsonl(path: string, event: AuditEventEnvelope): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) closeSync(openSync(path, "a"));
  withFileLockSync(
    path,
    () => {
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
    },
    { onLocked: "skip" },
  );
}

function appendAuditProjection(basePath: string, event: AuditEventEnvelope): void {
  appendLockedJsonl(auditLogPath(basePath), event);
}

function appendLifecycleShadowLossSpool(basePath: string, event: AuditEventEnvelope): void {
  appendLockedJsonl(
    join(gsdRoot(basePath), "runtime", "lifecycle-shadow-observation-loss.jsonl"),
    event,
  );
}

function appendLifecycleShadowEmergencyLoss(basePath: string, event: AuditEventEnvelope): void {
  appendLockedJsonl(join(gsdRoot(basePath), "lifecycle-shadow-observation-loss.jsonl"), event);
}

function persistLifecycleShadowLossOutsideDb(basePath: string, event: AuditEventEnvelope): void {
  try {
    appendAuditProjection(basePath, event);
    return;
  } catch {
    // Continue to the retry spool.
  }
  try {
    appendLifecycleShadowLossSpool(basePath, event);
    return;
  } catch {
    // Continue to the emergency loss journal.
  }
  try {
    appendLifecycleShadowEmergencyLoss(basePath, event);
  } catch {
    // No durable accounting is possible when the entire workspace is unwritable.
  }
}

function existingLifecycleShadowLossCauses(
  accounting: LifecycleShadowObservation["observationLossAccounting"],
): NonNullable<LifecycleShadowObservation["observationLossAccounting"]["causes"]> {
  if (accounting.causes) return accounting.causes;
  return accounting.lossCount > 0 && accounting.reason && accounting.errorHash
    ? [{ reason: accounting.reason, errorHash: accounting.errorHash }]
    : [];
}

export function buildAuditEnvelope(args: {
  traceId: string;
  turnId?: string;
  causedBy?: string;
  category: AuditEventEnvelope["category"];
  type: string;
  payload?: Record<string, unknown>;
}): AuditEventEnvelope {
  return {
    version: CURRENT_UOK_CONTRACT_VERSION,
    eventId: randomUUID(),
    traceId: args.traceId,
    turnId: args.turnId,
    causedBy: args.causedBy,
    category: args.category,
    type: args.type,
    ts: new Date().toISOString(),
    payload: args.payload ?? {},
  };
}

export function emitUokAuditEvent(basePath: string, event: AuditEventEnvelope): void {
  // Drop writes from a turn superseded by timeout recovery / cancellation.
  if (isStaleWrite("uok-audit")) return;
  if (!isUnifiedAuditEnabled(basePath)) return;
  const validation = validateAuditEvent(event);
  if (!validation.ok) {
    throw new Error(`Invalid UOK audit event: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const canonical = validation.value;

  if (isDbAvailable()) {
    try {
      insertAuditEvent({
        ...canonical,
        payload: {
          ...canonical.payload,
          contractVersion: canonical.version ?? CURRENT_UOK_CONTRACT_VERSION,
        },
      });
    } catch (err) {
      throw new Error(`DB authoritative audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    appendAuditProjection(basePath, canonical);
  } catch {
    // Best-effort: audit writes must never break orchestration.
  }
}

export function emitLifecycleShadowObservation(
  basePath: string,
  observation: LifecycleShadowObservation,
): void {
  const event = buildAuditEnvelope({
    traceId: observation.traceId ?? `milestone-status:${observation.milestoneId}`,
    ...(observation.turnId ? { turnId: observation.turnId } : {}),
    category: "execution",
    type: "lifecycle-shadow-observed",
    payload: { ...observation },
  });

  try {
    if (!isDbAvailable()) throw new Error("GSD database is not available");
    insertAuditEvent(event);
  } catch (error) {
    const sinkCause = {
      reason: "primary_sink_failed" as const,
      errorHash: lifecycleShadowErrorHash(error),
    };
    const priorLoss = observation.observationLossAccounting;
    const priorCauses = existingLifecycleShadowLossCauses(priorLoss);
    const fallback = buildAuditEnvelope({
      traceId: event.traceId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      causedBy: event.eventId,
      category: "execution",
      type: "lifecycle-shadow-observation-loss",
      payload: {
        ...observation,
        observationLossAccounting: {
          lossCount: priorLoss.lossCount + 1,
          persistedCount: 0,
          ...sinkCause,
          ...(priorCauses.length > 0 ? { causes: [...priorCauses, sinkCause] } : {}),
        },
      },
    });
    persistLifecycleShadowLossOutsideDb(basePath, fallback);
    return;
  }

  try {
    appendAuditProjection(basePath, event);
  } catch (error) {
    const projectionCause = {
      reason: "projection_sink_failed" as const,
      errorHash: lifecycleShadowErrorHash(error),
    };
    const lossEvent = buildAuditEnvelope({
      traceId: event.traceId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      causedBy: event.eventId,
      category: "execution",
      type: "lifecycle-shadow-observation-loss",
      payload: {
        ...observation,
        observationLossAccounting: {
          lossCount: observation.observationLossAccounting.lossCount + 1,
          persistedCount: 1,
          ...projectionCause,
          causes: [
            ...existingLifecycleShadowLossCauses(observation.observationLossAccounting),
            projectionCause,
          ],
        },
      },
    });
    try {
      insertAuditEvent(lossEvent);
    } catch {
      persistLifecycleShadowLossOutsideDb(basePath, lossEvent);
    }
  }
}
