import { getDbOrNull } from "./db/engine.js";
import { workflowEventArchivePath, workflowEventLogPath } from "./workflow-event-ledger.js";
import { readEvents } from "./workflow-events.js";
import { normalizeWorkflowEventCommand } from "./workflow-event-vocabulary.js";

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
      const cmd = normalizeWorkflowEventCommand(event.cmd);
      if (cmd !== "reopen_milestone" || eventMilestoneId !== milestoneId) continue;
      if (!latest || event.ts > latest) latest = event.ts;
    }
  }
  return latest;
}

/**
 * Latest `milestone.completed` timestamp for a milestone (#2398), mirroring
 * latestExplicitReopenAt: the durable workflow_domain_events row is
 * authoritative (written by the milestone.complete domain operation), with
 * the legacy file event ledger (`complete-milestone`) as the fallback for
 * completions that predate the durable event table.
 */
export function latestMilestoneCompletedAt(basePath: string, milestoneId: string): string | null {
  const durable = getDbOrNull()?.prepare(`
    SELECT created_at
    FROM workflow_domain_events
    WHERE event_type = 'milestone.completed'
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
      // Legacy ledgers spell commands with underscores (complete_milestone);
      // canonical events use hyphens. Normalize before matching.
      const cmd = normalizeWorkflowEventCommand(event.cmd);
      if (cmd !== "complete_milestone" || eventMilestoneId !== milestoneId) continue;
      if (!latest || event.ts > latest) latest = event.ts;
    }
  }
  return latest;
}

/**
 * Whether a milestone.completed event confirms the completion carried by a
 * closeout dispatch that started at `dispatchStartedAt` (#2398). The event is
 * minted inside the closeout — between the dispatch's started_at and the
 * ended_at that markCompleted stamps afterwards — so the comparison window
 * opens at started_at (comparing against ended_at would reject every genuine
 * completion). Without a covering event, a status='completed' dispatch row is
 * closeout debris (a failed attempt run or a session exit), not proof the
 * milestone ever completed.
 */
export function completedEventCoversDispatch(
  basePath: string,
  milestoneId: string,
  dispatchStartedAt: string | null | undefined,
): boolean {
  const completedAt = latestMilestoneCompletedAt(basePath, milestoneId);
  if (!completedAt) return false;
  if (!dispatchStartedAt) return true;
  return Date.parse(completedAt) >= Date.parse(dispatchStartedAt);
}

export function isAfter(value: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff) return true;
  if (!value) return true;
  return Date.parse(value) > Date.parse(cutoff);
}
