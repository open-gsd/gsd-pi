import { getDbOrNull } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import { executeDomainOperation } from "./gsd-db.js";
import { workflowEventArchivePath, workflowEventLogPath } from "./workflow-event-ledger.js";
import { readEvents } from "./workflow-events.js";
import { normalizeWorkflowEventCommand } from "./workflow-event-vocabulary.js";

type MilestoneEventKind = "reopened" | "completed";

/**
 * A milestone reopen or completion that has no canonical `milestone.<kind>`
 * event: the unadopted tool branch made it, or only a file ledger holds it.
 */
export interface LegacyMilestoneEvent {
  kind: MilestoneEventKind;
  milestoneId: string;
  occurredAt: string;
}

const LEGACY_LEDGER_COMMAND: Record<MilestoneEventKind, string> = {
  reopened: "reopen_milestone",
  completed: "complete_milestone",
};

/**
 * Time of the newest reopen or completion event of a milestone. Only the
 * database is read: the canonical event of the Domain Operation, or the
 * `milestone.legacy_<kind>` event of recordLegacyMilestoneEvents.
 */
function latestMilestoneEventAt(kind: MilestoneEventKind, milestoneId: string): string | null {
  const row = getDbOrNull()?.prepare(`
    SELECT COALESCE(json_extract(payload_json, '$.occurredAt'), created_at) AS occurred_at
    FROM workflow_domain_events
    WHERE event_type IN (:canonical, :legacy)
      AND entity_type = 'milestone'
      AND entity_id = :milestone_id
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 1
  `).get({
    ":canonical": `milestone.${kind}`,
    ":legacy": `milestone.legacy_${kind}`,
    ":milestone_id": milestoneId,
  });
  return row ? String(row["occurred_at"]) : null;
}

export function latestExplicitReopenAt(milestoneId: string): string | null {
  return latestMilestoneEventAt("reopened", milestoneId);
}

/**
 * Record milestone reopens and completions that have no canonical event, in
 * one Domain Operation. `occurredAt` keeps the time the event happened, which
 * for an import is older than the operation.
 */
export function recordLegacyMilestoneEvents(
  events: readonly LegacyMilestoneEvent[],
  actorType: "agent" | "operator",
): void {
  if (events.length === 0) return;
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "milestone.legacy_events.record",
    idempotencyKey: `milestone.legacy_events.record/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType,
    sourceTransport: "internal",
    payload: { events: events.map((event) => ({ ...event })) },
  }, () => ({
    events: events.map((event) => ({
      eventType: `milestone.legacy_${event.kind}`,
      entityType: "milestone",
      entityId: event.milestoneId,
      payload: { occurredAt: event.occurredAt },
      destinations: ["db"],
    })),
    // No hierarchy file changes; STATE.md is the projection of the operation.
    projections: [{ projectionKey: "milestones/legacy-events", projectionKind: "state", rendererVersion: "1" }],
  }));
}

/**
 * The newest reopen and completion that `.gsd/event-log.jsonl` and the
 * milestone archive hold for a database milestone that has no event of that
 * kind in the database. Runtime does not read these files: doctor reports the
 * events and `doctor --fix` imports them with recordLegacyMilestoneEvents.
 */
export function unimportedLegacyMilestoneEvents(basePath: string): LegacyMilestoneEvent[] {
  const db = getDbOrNull();
  if (!db) return [];
  const activeLog = readEvents(workflowEventLogPath(basePath));
  const unimported: LegacyMilestoneEvent[] = [];
  for (const row of db.prepare("SELECT id FROM milestones ORDER BY id").all()) {
    const milestoneId = String(row["id"]);
    const fileEvents = [...activeLog, ...readEvents(workflowEventArchivePath(basePath, milestoneId))];
    for (const kind of ["completed", "reopened"] as const) {
      if (latestMilestoneEventAt(kind, milestoneId)) continue;
      let latest: string | null = null;
      for (const event of fileEvents) {
        // Legacy ledgers spell commands with underscores (complete_milestone);
        // canonical events use hyphens. Normalize before matching.
        if (normalizeWorkflowEventCommand(event.cmd) !== LEGACY_LEDGER_COMMAND[kind]) continue;
        if ((event.params as { milestoneId?: unknown }).milestoneId !== milestoneId) continue;
        if (!latest || event.ts > latest) latest = event.ts;
      }
      if (latest) unimported.push({ kind, milestoneId, occurredAt: latest });
    }
  }
  return unimported;
}

/**
 * Recovery text for a completion artifact row that blocks only because an
 * older release reopened its milestone and the reopen is in a file ledger:
 * the row is not newer than that reopen, so the import clears the drift.
 * Null when no such reopen covers the row. The file is read only to choose
 * the message.
 */
export function legacyReopenImportGuidance(
  basePath: string,
  milestoneId: string,
  artifactImportedAt: string | null,
): string | null {
  const reopen = unimportedLegacyMilestoneEvents(basePath).find(
    (event) => event.kind === "reopened" && event.milestoneId === milestoneId,
  );
  if (!reopen || isAfter(artifactImportedAt, reopen.occurredAt)) return null;
  return (
    `An older release reopened milestone ${milestoneId}, and that reopen is only in event-log.jsonl, which runtime does not read. ` +
    "Run `/gsd doctor --fix` to import the reopen. This artifact is not newer than the reopen, so it stops blocking after the import."
  );
}

/**
 * Whether a milestone completion event confirms the completion carried by a
 * closeout dispatch that started at `dispatchStartedAt` (#2398). The event is
 * minted inside the closeout — between the dispatch's started_at and the
 * ended_at that markCompleted stamps afterwards — so the comparison window
 * opens at started_at (comparing against ended_at would reject every genuine
 * completion). Without a covering event, a status='completed' dispatch row is
 * closeout debris (a failed attempt run or a session exit), not proof the
 * milestone ever completed.
 */
export function completedEventCoversDispatch(
  milestoneId: string,
  dispatchStartedAt: string | null | undefined,
): boolean {
  const completedAt = latestMilestoneEventAt("completed", milestoneId);
  if (!completedAt) return false;
  if (!dispatchStartedAt) return true;
  return Date.parse(completedAt) >= Date.parse(dispatchStartedAt);
}

export function isAfter(value: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff) return true;
  if (!value) return true;
  return Date.parse(value) > Date.parse(cutoff);
}
