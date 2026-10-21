import { getDbOrNull } from "./db/engine.js";
import { workflowEventArchivePath, workflowEventLogPath } from "./workflow-event-ledger.js";
import { readEvents } from "./workflow-events.js";

export function latestExplicitReopenAt(basePath: string, milestoneId: string): string | null {
  const durable = getDbOrNull()?.prepare(`
    SELECT created_at
    FROM workflow_domain_events
    WHERE event_type = 'milestone.reopened'
      AND entity_type = 'milestone'
      AND entity_id = :milestone_id
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId });
  if (durable) return String(durable["created_at"]);

  const candidates = [
    workflowEventLogPath(basePath),
    workflowEventArchivePath(basePath, milestoneId),
  ];

  let latest: string | null = null;
  for (const file of candidates) {
    for (const event of readEvents(file)) {
      const eventMilestoneId = (event.params as { milestoneId?: unknown }).milestoneId;
      if (event.cmd !== "reopen-milestone" || eventMilestoneId !== milestoneId) continue;
      if (!latest || event.ts > latest) latest = event.ts;
    }
  }
  return latest;
}

export function isAfter(value: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff) return true;
  if (!value) return true;
  return Date.parse(value) > Date.parse(cutoff);
}
