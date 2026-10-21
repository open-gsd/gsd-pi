// Project/App: gsd-pi
// File Purpose: Atomic read-only capture of the canonical rows relevant to legacy import Preview.

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportSha256,
  type LegacyImportValue,
} from "./legacy-import-contract.js";
import { type DbAdapter } from "./db-adapter.js";
import { getCurrentSchemaVersion } from "./db-schema-metadata.js";
import { getDb, readTransaction } from "./db/engine.js";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "./legacy-import-preview.js";

export const LEGACY_IMPORT_BASE_ROW_SETS = [
  "milestones",
  "slices",
  "tasks",
  "slice_dependencies",
  "requirements",
  "artifacts",
  "assessments",
  "decisions",
  "decision_memories",
  "item_lifecycles",
] as const;

export type LegacyImportBaseRowSet = (typeof LEGACY_IMPORT_BASE_ROW_SETS)[number];

export const LEGACY_IMPORT_BASE_IDENTITY_COLUMNS: Record<LegacyImportBaseRowSet, readonly string[]> = {
  milestones: ["id"],
  slices: ["milestone_id", "id"],
  tasks: ["milestone_id", "slice_id", "id"],
  slice_dependencies: ["milestone_id", "slice_id", "depends_on_slice_id"],
  requirements: ["id"],
  artifacts: ["path"],
  assessments: ["path"],
  decisions: ["id"],
  decision_memories: ["source_decision_id"],
  item_lifecycles: ["project_id", "item_kind", "milestone_id", "slice_id", "task_id"],
};

const ROW_SET_QUERIES: Record<LegacyImportBaseRowSet, string> = {
  milestones: `SELECT
    id, title, status, depends_on, completed_at, vision, success_criteria,
    key_risks, proof_strategy, verification_contract, verification_integration,
    verification_operational, verification_uat, definition_of_done,
    requirement_coverage, boundary_map_markdown, sequence
    FROM milestones`,
  slices: `SELECT
    milestone_id, id, title, status, risk, depends, demo, completed_at,
    full_summary_md, full_uat_md, goal, success_criteria, proof_level,
    integration_closure, observability_impact, target_repositories, sequence,
    replan_triggered_at, is_sketch, sketch_scope
    FROM slices`,
  tasks: `SELECT
    milestone_id, slice_id, id, title, status, one_liner, narrative,
    verification_result, duration, completed_at, blocker_discovered,
    blocker_source, escalation_pending, escalation_awaiting_review,
    escalation_artifact_path, escalation_override_applied_at, deviations,
    known_issues, key_files, key_decisions, full_summary_md, description,
    estimate, files, verify, inputs, expected_output, observability_impact,
    full_plan_md, target_repositories, sequence
    FROM tasks`,
  slice_dependencies: `SELECT milestone_id, slice_id, depends_on_slice_id
    FROM slice_dependencies`,
  requirements: `SELECT
    id, class, status, description, why, source, primary_owner,
    supporting_slices, validation, notes, full_content, superseded_by
    FROM requirements`,
  artifacts: `SELECT
    path, artifact_type, milestone_id, slice_id, task_id, full_content, content_hash
    FROM artifacts`,
  assessments: `SELECT path, milestone_id, slice_id, task_id, status, scope, full_content
    FROM assessments`,
  decisions: `SELECT
    id, when_context, scope, decision, choice, rationale, revisable,
    made_by, source, superseded_by
    FROM decisions`,
  decision_memories: `SELECT
      CASE WHEN json_valid(structured_fields)
        THEN json_extract(structured_fields, '$.sourceDecisionId')
        ELSE NULL
      END AS source_decision_id,
      structured_fields
    FROM memories
    WHERE category = 'architecture'
      AND instr(structured_fields, '"sourceDecisionId"') > 0`,
  item_lifecycles: `SELECT
    project_id, item_kind, milestone_id, slice_id, task_id, lifecycle_status,
    state_version, last_operation_id
    FROM workflow_item_lifecycles`,
};

export interface LegacyImportBaseAuthority {
  singleton: 1;
  project_id: string;
  project_root_realpath: string;
  revision: number;
  authority_epoch: number;
  created_at: string;
  updated_at: string;
}

export interface LegacyImportBaseRow {
  row_set: LegacyImportBaseRowSet;
  identity: string;
  value: Readonly<Record<string, LegacyImportValue>>;
}

export interface LegacyImportBaseSnapshot {
  snapshot_schema_version: 1;
  database_schema_version: typeof LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
  authority: LegacyImportBaseAuthority;
  rows: readonly LegacyImportBaseRow[];
  relevant_rows_hash: LegacyImportSha256;
}

export interface LegacyImportBaseSnapshotSource {
  readSchemaVersion(): unknown;
  readAuthorityRows(): readonly Record<string, unknown>[];
  readRows(rowSet: LegacyImportBaseRowSet): readonly Record<string, unknown>[];
}

export interface LegacyImportBaseSnapshotDependencies {
  readTransaction<T>(fn: () => T): T;
  source: LegacyImportBaseSnapshotSource;
}

export type LegacyImportBaseSnapshotErrorCode =
  | "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA"
  | "LEGACY_IMPORT_BASE_AUTHORITY_MISSING"
  | "LEGACY_IMPORT_BASE_AUTHORITY_DUPLICATE"
  | "LEGACY_IMPORT_BASE_AUTHORITY_INVALID"
  | "LEGACY_IMPORT_BASE_ROW_INVALID"
  | "LEGACY_IMPORT_BASE_ROW_DUPLICATE";

export class LegacyImportBaseSnapshotError extends Error {
  readonly stage = "base-snapshot";
  readonly retryable = false;
  readonly code: LegacyImportBaseSnapshotErrorCode;
  readonly context: Readonly<Record<string, LegacyImportValue>>;

  constructor(
    code: LegacyImportBaseSnapshotErrorCode,
    message: string,
    context: Readonly<Record<string, LegacyImportValue>> = {},
  ) {
    super(message);
    this.name = "LegacyImportBaseSnapshotError";
    this.code = code;
    this.context = context;
  }
}

function fail(
  code: LegacyImportBaseSnapshotErrorCode,
  message: string,
  context: Readonly<Record<string, LegacyImportValue>> = {},
): never {
  throw new LegacyImportBaseSnapshotError(code, message, context);
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("LEGACY_IMPORT_BASE_AUTHORITY_INVALID", `${field} must be a non-negative safe integer`, {
      field,
      observed_type: typeof value,
    });
  }
  return value;
}

function requireString(value: unknown, field: string, allowBlank = true): string {
  if (typeof value !== "string" || (!allowBlank && value.trim().length === 0)) {
    fail("LEGACY_IMPORT_BASE_AUTHORITY_INVALID", `${field} must be ${allowBlank ? "a string" : "non-blank"}`, {
      field,
      observed_type: typeof value,
    });
  }
  return value;
}

function authorityFrom(rows: readonly Record<string, unknown>[]): LegacyImportBaseAuthority {
  if (rows.length === 0) {
    fail("LEGACY_IMPORT_BASE_AUTHORITY_MISSING", "current database has no project authority row");
  }
  if (rows.length !== 1) {
    fail("LEGACY_IMPORT_BASE_AUTHORITY_DUPLICATE", "current database has multiple project authority rows", {
      row_count: rows.length,
    });
  }
  const row = rows[0];
  if (row["singleton"] !== 1) {
    fail("LEGACY_IMPORT_BASE_AUTHORITY_INVALID", "project authority singleton must equal 1", {
      singleton: typeof row["singleton"] === "number" ? row["singleton"] : null,
    });
  }
  return {
    singleton: 1,
    project_id: requireString(row["project_id"], "project_authority.project_id", false),
    project_root_realpath: requireString(row["project_root_realpath"], "project_authority.project_root_realpath"),
    revision: requireSafeInteger(row["revision"], "project_authority.revision"),
    authority_epoch: requireSafeInteger(row["authority_epoch"], "project_authority.authority_epoch"),
    created_at: requireString(row["created_at"], "project_authority.created_at"),
    updated_at: requireString(row["updated_at"], "project_authority.updated_at"),
  };
}

function rowValue(
  rowSet: LegacyImportBaseRowSet,
  rowIndex: number,
  row: Record<string, unknown>,
): Readonly<Record<string, LegacyImportValue>> {
  const value: Record<string, LegacyImportValue> = {};
  for (const [column, entry] of Object.entries(row)) {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      value[column] = entry;
    } else if (
      typeof entry === "number"
      && Number.isFinite(entry)
      && (!Number.isInteger(entry) || Number.isSafeInteger(entry))
    ) {
      value[column] = entry;
    } else {
      fail("LEGACY_IMPORT_BASE_ROW_INVALID", "base row contains a non-JSON SQLite value", {
        row_set: rowSet,
        row_index: rowIndex,
        column,
        observed_type: typeof entry,
      });
    }
  }
  return value;
}

function identityFor(
  rowSet: LegacyImportBaseRowSet,
  rowIndex: number,
  value: Readonly<Record<string, LegacyImportValue>>,
): string {
  const identity: Record<string, LegacyImportValue> = {};
  for (const column of LEGACY_IMPORT_BASE_IDENTITY_COLUMNS[rowSet]) {
    const entry = value[column];
    const nullableHierarchyPart = (
      (rowSet === "assessments" || rowSet === "item_lifecycles")
      && (column === "slice_id" || column === "task_id")
    );
    if (
      (entry === null && !nullableHierarchyPart)
      || (entry !== null && (typeof entry !== "string" || entry.trim().length === 0))
    ) {
      fail("LEGACY_IMPORT_BASE_ROW_INVALID", "base row is missing a canonical identity value", {
        row_set: rowSet,
        row_index: rowIndex,
        column,
      });
    }
    identity[column] = entry;
  }
  return canonicalLegacyImportJson(identity);
}

function captureRows(source: LegacyImportBaseSnapshotSource): LegacyImportBaseRow[] {
  const captured: LegacyImportBaseRow[] = [];
  const identities = new Set<string>();
  for (const rowSet of LEGACY_IMPORT_BASE_ROW_SETS) {
    source.readRows(rowSet).forEach((rawRow, rowIndex) => {
      const value = rowValue(rowSet, rowIndex, rawRow);
      const identity = identityFor(rowSet, rowIndex, value);
      const uniqueIdentity = `${rowSet}\0${identity}`;
      if (identities.has(uniqueIdentity)) {
        fail("LEGACY_IMPORT_BASE_ROW_DUPLICATE", "base snapshot contains duplicate logical row identity", {
          row_set: rowSet,
          identity,
        });
      }
      identities.add(uniqueIdentity);
      captured.push({ row_set: rowSet, identity, value });
    });
  }
  return captured.sort((left, right) => {
    const rowSetOrder = LEGACY_IMPORT_BASE_ROW_SETS.indexOf(left.row_set)
      - LEGACY_IMPORT_BASE_ROW_SETS.indexOf(right.row_set);
    return rowSetOrder || (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  });
}

function freezeSnapshot(snapshot: LegacyImportBaseSnapshot): LegacyImportBaseSnapshot {
  snapshot.rows.forEach((row) => {
    Object.freeze(row.value);
    Object.freeze(row);
  });
  Object.freeze(snapshot.rows);
  Object.freeze(snapshot.authority);
  return Object.freeze(snapshot);
}

export function createLegacyImportBaseSnapshotSource(
  db: DbAdapter,
): LegacyImportBaseSnapshotSource {
  return {
    readSchemaVersion: () => getCurrentSchemaVersion(db),
    readAuthorityRows: () => db.prepare(`
      SELECT singleton, project_id, project_root_realpath,
             revision, authority_epoch, created_at, updated_at
      FROM project_authority
    `).all(),
    readRows: (rowSet) => db.prepare(ROW_SET_QUERIES[rowSet]).all(),
  };
}

export function captureLegacyImportBaseSnapshot(
  dependencies: LegacyImportBaseSnapshotDependencies,
): LegacyImportBaseSnapshot {
  return dependencies.readTransaction(() => {
    const observedSchema = dependencies.source.readSchemaVersion();
    if (observedSchema !== LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION) {
      fail(
        "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA",
        `legacy import Preview requires database schema ${LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION}`,
        {
          expected_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
          observed_schema_version: typeof observedSchema === "number" ? observedSchema : null,
        },
      );
    }
    const authority = authorityFrom(dependencies.source.readAuthorityRows());
    const rows = captureRows(dependencies.source);
    return freezeSnapshot({
      snapshot_schema_version: 1,
      database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      authority,
      rows,
      relevant_rows_hash: hashLegacyImportValue(rows),
    });
  });
}

/** Capture from the already-open authority database; this never opens or initializes a DB. */
export function captureCurrentLegacyImportBaseSnapshot(): LegacyImportBaseSnapshot {
  const source = createLegacyImportBaseSnapshotSource(getDb());
  return captureLegacyImportBaseSnapshot({ readTransaction, source });
}
