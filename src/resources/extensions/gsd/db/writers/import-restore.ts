// Project/App: gsd-pi
// File Purpose: Guard for destructive hierarchy writers in the single-writer
// layer: refuses to replace rows that have canonical lifecycle history.
import { getDbOrNull } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";

export function assertNoAdoptedLifecycleHistory(
  operation: string,
  milestoneIds?: readonly string[],
): void {
  const db = getDbOrNull();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  if (milestoneIds?.length === 0) return;

  const scope = milestoneIds
    ? ` WHERE milestone_id IN (${milestoneIds.map(() => "?").join(",")})`
    : "";
  const adopted = db.prepare(
    `SELECT 1 AS adopted FROM workflow_item_lifecycles${scope} LIMIT 1`,
  ).get(...(milestoneIds ?? []));
  if (adopted !== undefined) {
    throw new GSDError(
      GSD_STALE_STATE,
      `${operation}: cannot replace hierarchy with adopted canonical lifecycle history`,
    );
  }
}
