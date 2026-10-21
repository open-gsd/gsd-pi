// Project/App: gsd-pi
// File Purpose: Atomic fail-closed deletion of DB-only milestone reservations.

import { getDbOrNull, immediateTransaction, readTransaction } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";

export interface OrphanMilestoneDbSnapshot {
  id: string;
  dbRow: boolean;
  status?: string;
  planningFields: string[];
  relatedRows: Record<string, number>;
  dependentMilestones: string[];
}

export type OrphanMilestoneDbDiscardResult =
  | { ok: true; before: OrphanMilestoneDbSnapshot[]; after: OrphanMilestoneDbSnapshot[] }
  | { ok: false; before: OrphanMilestoneDbSnapshot[]; after: OrphanMilestoneDbSnapshot[]; errors: string[] };

const CONTENT_COLUMNS = [
  "vision",
  "success_criteria",
  "key_risks",
  "proof_strategy",
  "verification_contract",
  "verification_integration",
  "verification_operational",
  "verification_uat",
  "definition_of_done",
  "requirement_coverage",
  "boundary_map_markdown",
] as const;

const AUXILIARY_ACTIVE_SURFACES = [
  {
    table: "milestone_leases",
    where: `milestone_id = :id AND (
      datetime(expires_at) IS NULL
      OR status NOT IN ('held', 'expired', 'released')
      OR (status = 'held' AND datetime(expires_at) >= datetime('now'))
    )`,
  },
  { table: "runtime_kv", where: "scope = 'milestone' AND scope_id = :id" },
  { table: "cancellation_requests", where: "scope = 'milestone' AND scope_id = :id AND status NOT IN ('acked', 'completed', 'cancelled')" },
  { table: "liveness_block_signatures", where: "unit_id = :id" },
  { table: "liveness_wedge_records", where: "unit_id = :id AND acknowledged_at IS NULL" },
  { table: "turn_git_transactions", where: "unit_id = :id AND status NOT IN ('complete', 'completed', 'cancelled')" },
  {
    table: "command_queue",
    where: "completed_at IS NULL AND json_valid(args_json) AND EXISTS (SELECT 1 FROM json_tree(args_json) WHERE value = :id)",
  },
] as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed.length > 0 : parsed !== null;
  } catch {
    return true;
  }
}

function tablesWithMilestoneId(): string[] {
  const db = getDbOrNull()!;
  return db.prepare(
    `SELECT schema_table.name AS name
       FROM sqlite_schema AS schema_table
      WHERE schema_table.type = 'table'
        AND schema_table.name NOT LIKE 'sqlite_%'
        AND schema_table.name != 'milestones'
        AND schema_table.name != 'milestone_leases'
        AND EXISTS (
          SELECT 1 FROM pragma_table_info(schema_table.name) AS column_info
           WHERE column_info.name = 'milestone_id'
        )
      ORDER BY schema_table.name`,
  ).all().map((row) => String(row["name"]));
}

function inspect(ids: readonly string[]): OrphanMilestoneDbSnapshot[] {
  const db = getDbOrNull()!;
  const tables = tablesWithMilestoneId();
  const allMilestones = db.prepare("SELECT id, depends_on FROM milestones ORDER BY id").all();
  const malformedPendingCommands = Number(db.prepare(
    `SELECT COUNT(*) AS count
       FROM command_queue
      WHERE completed_at IS NULL
        AND CASE
          WHEN json_valid(args_json) THEN json_type(args_json) != 'object'
          ELSE 1
        END`,
  ).get()?.["count"] ?? 0);

  return ids.map((id) => {
    const row = db.prepare("SELECT * FROM milestones WHERE id = :id").get({ ":id": id });
    const planningFields: string[] = row
      ? CONTENT_COLUMNS.filter((column) => hasContent(row[column]))
      : [];
    if (row && Number(row["sequence"] ?? 0) !== 0) planningFields.push("sequence");
    const relatedRows: Record<string, number> = {};
    if (malformedPendingCommands > 0) relatedRows.command_queue_malformed = malformedPendingCommands;
    for (const table of tables) {
      const countRow = db.prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE milestone_id = :id`,
      ).get({ ":id": id });
      const count = Number(countRow?.["count"] ?? 0);
      if (count > 0) relatedRows[table] = count;
    }
    for (const surface of AUXILIARY_ACTIVE_SURFACES) {
      const count = Number(db.prepare(
        `SELECT COUNT(*) AS count FROM ${surface.table} WHERE ${surface.where}`,
      ).get({ ":id": id })?.["count"] ?? 0);
      if (count > 0) relatedRows[surface.table] = count;
    }

    const dependentMilestones = allMilestones.flatMap((candidate) => {
      if (String(candidate["id"]) === id) return [];
      try {
        const dependencies = JSON.parse(String(candidate["depends_on"] || "[]")) as unknown;
        return Array.isArray(dependencies) && dependencies.includes(id) ? [String(candidate["id"])] : [];
      } catch {
        return [String(candidate["id"])];
      }
    });

    return {
      id,
      dbRow: row !== undefined,
      ...(row ? { status: String(row["status"] ?? "") } : {}),
      planningFields,
      relatedRows,
      dependentMilestones,
    };
  });
}

function refusalErrors(snapshots: readonly OrphanMilestoneDbSnapshot[], targetIds: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.dbRow) {
      errors.push(`${snapshot.id}: milestone DB row does not exist`);
      continue;
    }
    if (snapshot.planningFields.length > 0) {
      errors.push(`${snapshot.id}: planning content exists in ${snapshot.planningFields.join(", ")}`);
    }
    for (const [table, count] of Object.entries(snapshot.relatedRows)) {
      errors.push(`${snapshot.id}: ${table} contains ${count} related row${count === 1 ? "" : "s"}`);
    }
    for (const dependent of snapshot.dependentMilestones) {
      if (!targetIds.has(dependent)) errors.push(`${dependent} depends on ${snapshot.id}`);
    }
  }
  return errors;
}

export function preflightOrphanMilestoneRows(ids: readonly string[]): {
  before: OrphanMilestoneDbSnapshot[];
  errors: string[];
} {
  if (!getDbOrNull()) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return readTransaction(() => {
    const before = inspect(ids);
    return { before, errors: refusalErrors(before, new Set(ids)) };
  });
}

/**
 * Preflight every ID against the same reserved-writer snapshot, then delete the
 * complete set in one transaction. Expected refusals return without mutation;
 * unexpected SQL or verification failures throw and roll back.
 */
export function discardOrphanMilestoneRows(ids: readonly string[]): OrphanMilestoneDbDiscardResult {
  if (!getDbOrNull()) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return immediateTransaction(() => {
    const before = inspect(ids);
    const errors = refusalErrors(before, new Set(ids));
    if (errors.length > 0) return { ok: false, before, after: before, errors };

    const placeholders = ids.map(() => "?").join(",");
    getDbOrNull()!.prepare(`DELETE FROM milestone_leases WHERE milestone_id IN (${placeholders})`).run(...ids);
    getDbOrNull()!.prepare(`DELETE FROM milestones WHERE id IN (${placeholders})`).run(...ids);
    const after = inspect(ids);
    if (after.some((snapshot) => snapshot.dbRow)) {
      throw new GSDError(GSD_STALE_STATE, "orphan milestone discard verification failed; transaction rolled back");
    }
    return { ok: true, before, after };
  });
}
