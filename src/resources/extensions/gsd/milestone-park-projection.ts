// Project/App: gsd-pi
// File Purpose: Render the PARKED marker from the database park record.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteSync, removeProjectionFileSync } from "./atomic-write.js";
import { getDbOrNull } from "./db/engine.js";
import { relMilestoneFile, resolveMilestonePath } from "./paths.js";

export interface MilestoneParkRecord {
  reason: string;
  parkedAt: string;
}

/**
 * The reason and time of the current park, read from the milestone.parked
 * event of the Domain Operation that parked it. Null when the milestone is
 * not parked.
 */
export function readMilestoneParkRecord(milestoneId: string): MilestoneParkRecord | null {
  const row = getDbOrNull()?.prepare(`
    SELECT json_extract(event.payload_json, '$.reason') AS reason,
           json_extract(event.payload_json, '$.parkedAt') AS parked_at
    FROM milestones milestone
    JOIN workflow_domain_events event
      ON event.event_type = 'milestone.parked'
     AND event.entity_type = 'milestone'
     AND event.entity_id = milestone.id
    WHERE milestone.id = :milestone_id AND milestone.status = 'parked'
    ORDER BY event.project_revision DESC
    LIMIT 1
  `).get({ ":milestone_id": milestoneId }) as Record<string, unknown> | undefined;
  if (!row || typeof row["reason"] !== "string") return null;
  return { reason: row["reason"], parkedAt: String(row["parked_at"] ?? "") };
}

/**
 * Write or remove `{ID}-PARKED.md` so it matches the database. The marker is
 * a projection only: it is rendered when the milestone directory exists and
 * is never read back as park state.
 */
export function renderMilestoneParkedMarker(basePath: string, milestoneId: string): boolean {
  const db = getDbOrNull();
  const milestoneDir = resolveMilestonePath(basePath, milestoneId);
  if (!db || !milestoneDir || !existsSync(milestoneDir)) return false;
  const parkedPath = join(basePath, relMilestoneFile(basePath, milestoneId, "PARKED"));
  const status = db.prepare("SELECT status FROM milestones WHERE id = :id")
    .get({ ":id": milestoneId })?.["status"];
  if (status !== "parked") {
    if (!existsSync(parkedPath)) return false;
    removeProjectionFileSync(parkedPath);
    return true;
  }
  // A milestone parked before parks were Domain Operations has no park record;
  // its existing marker is the only copy of the reason, so leave it in place.
  const record = readMilestoneParkRecord(milestoneId);
  if (!record) return false;
  const content = [
    "---",
    `parked_at: ${record.parkedAt}`,
    `reason: "${record.reason.replace(/"/g, '\\"')}"`,
    "---",
    "",
    `# ${milestoneId} — Parked`,
    "",
    `> ${record.reason}`,
    "",
  ].join("\n");
  // A render of an unchanged park record writes nothing.
  if (existsSync(parkedPath) && readFileSync(parkedPath, "utf-8") === content) return false;
  atomicWriteSync(parkedPath, content, "utf-8");
  return true;
}
