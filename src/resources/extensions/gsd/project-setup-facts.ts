// Project/App: gsd-pi
// File Purpose: Deep project setup stage facts, read from database rows and written as Domain Operation events.

import type { DomainJsonValue } from "./db/domain-operation.js";
import { getDbOrNull } from "./db/engine.js";
import { getArtifact } from "./db/queries.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { executeDomainOperation } from "./gsd-db.js";
import { internalPlanningInvocation, type PlanningInvocation } from "./planning-invocation.js";
import { validateArtifactContent } from "./schemas/validate.js";

export type ProjectResearchDecision = "research" | "skip";

type SetupFactStage = "workflow-preferences" | "research-decision";

function recordSetupFact(
  stage: SetupFactStage,
  payload: { [key: string]: DomainJsonValue },
  invocation: PlanningInvocation,
): void {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  executeDomainOperation({
    operationType: "project.setup.record",
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload: { stage, ...payload },
  }, () => ({
    events: [{
      eventType: "project.setup.recorded",
      entityType: "project-setup",
      entityId: stage,
      payload,
      destinations: ["projection"],
    }],
    projections: [{ projectionKey: "state", projectionKind: "state", rendererVersion: "1" }],
  }));
}

/** The payload of the newest fact of a stage, or null when none is recorded or no database is open. */
function readSetupFact(stage: SetupFactStage): Record<string, unknown> | null {
  const row = getDbOrNull()?.prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'project.setup.recorded'
      AND entity_type = 'project-setup'
      AND entity_id = :stage
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 1
  `).get({ ":stage": stage });
  if (typeof row?.["payload_json"] !== "string") return null;
  return JSON.parse(row["payload_json"]) as Record<string, unknown>;
}

export function isWorkflowPreferencesCaptured(): boolean {
  return readSetupFact("workflow-preferences") !== null;
}

export function recordWorkflowPreferencesCaptured(): void {
  recordSetupFact("workflow-preferences", {}, internalPlanningInvocation());
}

/** The recorded project research decision, or null when the user has not decided. */
export function readResearchDecision(): ProjectResearchDecision | null {
  const decision = readSetupFact("research-decision")?.["decision"];
  return decision === "research" || decision === "skip" ? decision : null;
}

export function recordResearchDecision(
  decision: ProjectResearchDecision,
  invocation: PlanningInvocation = internalPlanningInvocation(),
): void {
  recordSetupFact("research-decision", { decision }, invocation);
}

/**
 * True when the PROJECT or REQUIREMENTS stage has saved a valid artifact row.
 * The rendered .gsd file is a projection and is not read.
 */
export function isSetupArtifactSaved(kind: "project" | "requirements"): boolean {
  const content = getArtifact(kind === "project" ? "PROJECT.md" : "REQUIREMENTS.md")?.full_content;
  return !!content && validateArtifactContent(content, kind).ok;
}
