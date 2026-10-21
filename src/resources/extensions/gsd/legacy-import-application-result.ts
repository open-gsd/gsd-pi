// Project/App: gsd-pi
// File Purpose: Independent verification of canonical rows produced by one retained Import Application.

import { getDb } from "./db/engine.js";
import type { LegacyImportApplicationEvidence } from "./legacy-import-application-evidence.js";
import type { LegacyImportApplicationPlanInstruction } from "./legacy-import-application-plan.js";
import {
  captureCurrentLegacyImportBaseSnapshot,
  LEGACY_IMPORT_BASE_IDENTITY_COLUMNS,
  type LegacyImportBaseRow,
  type LegacyImportBaseSnapshot,
} from "./legacy-import-preview-base.js";
import { canonicalLegacyImportJson, hashLegacyImportValue } from "./legacy-import-preview.js";
import type { LegacyImportValue } from "./legacy-import-contract.js";

function valuesMatch(
  actual: Readonly<Record<string, LegacyImportValue>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(expected).every(([key, value]) => (
    hashLegacyImportValue(actual[key] ?? null)
      === hashLegacyImportValue(value as LegacyImportValue)
  ));
}

function baseIdentity(
  rowSet: LegacyImportBaseRow["row_set"],
  identity: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const column of LEGACY_IMPORT_BASE_IDENTITY_COLUMNS[rowSet]) {
    normalized[column] = identity[column] ?? null;
  }
  return normalized;
}

function rowFor(
  snapshot: LegacyImportBaseSnapshot,
  rowSet: LegacyImportBaseRow["row_set"],
  identity: Readonly<Record<string, unknown>>,
): LegacyImportBaseRow | undefined {
  const canonicalIdentity = canonicalLegacyImportJson(
    baseIdentity(rowSet, identity) as Record<string, LegacyImportValue>,
  );
  return snapshot.rows.find((row) => row.row_set === rowSet && row.identity === canonicalIdentity);
}

function instructionMatches(
  snapshot: LegacyImportBaseSnapshot,
  instruction: LegacyImportApplicationPlanInstruction,
): boolean {
  if (instruction.action === "preserve") {
    if (instruction.rowSet === undefined || instruction.identity === undefined || instruction.values === undefined) {
      return true;
    }
    const row = rowFor(snapshot, instruction.rowSet, instruction.identity);
    return row !== undefined && valuesMatch(row.value, instruction.values);
  }
  if (instruction.action === "create" || instruction.action === "update" || instruction.action === "delete") {
    const row = rowFor(snapshot, instruction.rowSet, instruction.identity);
    return instruction.action === "delete"
      ? row === undefined
      : row !== undefined && valuesMatch(row.value, { ...instruction.identity, ...instruction.values });
  }
  if (instruction.action === "replace-slice-dependencies") {
    const dependencies = snapshot.rows
      .filter((row) => row.row_set === "slice_dependencies"
        && row.value["milestone_id"] === instruction.milestoneId
        && row.value["slice_id"] === instruction.sliceId)
      .map((row) => String(row.value["depends_on_slice_id"]))
      .sort();
    return dependencies.join("\0") === [...instruction.dependsOnSliceIds].sort().join("\0");
  }
  if (instruction.action === "delete-slice-dependencies") {
    return !snapshot.rows.some((row) => row.row_set === "slice_dependencies"
      && row.value["milestone_id"] === instruction.milestoneId
      && (row.value["slice_id"] === instruction.sliceId
        || row.value["depends_on_slice_id"] === instruction.sliceId));
  }
  if (instruction.action === "adopt-lifecycle") {
    const row = snapshot.rows.find((candidate) => candidate.row_set === "item_lifecycles"
      && candidate.value["item_kind"] === instruction.itemKind
      && candidate.value["milestone_id"] === instruction.milestoneId
      && candidate.value["slice_id"] === instruction.sliceId
      && candidate.value["task_id"] === instruction.taskId);
    return row?.value["lifecycle_status"] === instruction.lifecycleStatus;
  }
  if (instruction.action === "seed-quality-gate") {
    // quality_gates is not a Preview base row set, so the seeded Q8 row is
    // verified directly against the live database the snapshot was captured
    // from. Only existence is asserted — post-import slice work legitimately
    // moves the gate between pending and complete (reopen/complete), and the
    // invariant complete-slice enforces is exactly-one row, not its status.
    const row = getDb().prepare(`
      SELECT 1 AS present FROM quality_gates
      WHERE milestone_id = :milestone_id AND slice_id = :slice_id
        AND gate_id = 'Q8' AND scope = 'slice' AND (task_id = '' OR task_id IS NULL)
    `).get({
      ":milestone_id": instruction.milestoneId,
      ":slice_id": instruction.sliceId,
    });
    return Boolean(row);
  }
  if (instruction.action !== "create-decision-memory"
    && instruction.action !== "update-decision-memory"
    && instruction.action !== "delete-decision-memory") return false;

  const row = snapshot.rows.find((candidate) => candidate.row_set === "decision_memories"
    && candidate.value["source_decision_id"] === instruction.decisionId);
  if (row === undefined || typeof row.value["structured_fields"] !== "string") return false;
  let structured: unknown;
  try {
    structured = JSON.parse(row.value["structured_fields"]);
  } catch {
    return false;
  }
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) return false;
  const expectedDeleted = instruction.action === "delete-decision-memory";
  const decision: Record<string, LegacyImportValue> = {
    ...(structured as Record<string, LegacyImportValue>),
    id: instruction.decisionId,
  };
  return decision["deleted"] === expectedDeleted && valuesMatch(decision, instruction.values);
}

function verifyEveryPreviewChangeWasPlanned(application: LegacyImportApplicationEvidence): void {
  for (const change of application.preview.preview.changes) {
    const hierarchyKind = change.target.kind.endsWith("-status")
      ? change.target.kind.slice(0, change.target.kind.length - "-status".length)
      : change.target.kind;
    const instruction = application.plan.instructions.find((candidate) => (
      candidate.changeIds.includes(change.change_id)
      && candidate.targetKey === change.target.key
      && (change.action === "preserve") === (candidate.action === "preserve")
      && (candidate.targetKind === change.target.kind
        || (candidate.action === "adopt-lifecycle"
          && candidate.targetKind === `${hierarchyKind}-lifecycle`)
        || ((candidate.action === "replace-slice-dependencies"
          || candidate.action === "delete-slice-dependencies")
          && change.target.kind === "slice"))
    ));
    if (instruction === undefined) {
      throw new Error(
        `retained Application omitted Preview target ${change.target.kind}/${change.target.key}`,
      );
    }
  }
}

export function verifyLegacyImportApplicationTargets(
  application: LegacyImportApplicationEvidence,
): LegacyImportBaseSnapshot {
  verifyEveryPreviewChangeWasPlanned(application);
  const snapshot = captureCurrentLegacyImportBaseSnapshot();
  for (const instruction of application.plan.instructions) {
    if (!instructionMatches(snapshot, instruction)) {
      throw new Error(
        `canonical target ${instruction.targetKind}/${instruction.targetKey} did not match retained Application content`,
      );
    }
  }
  return snapshot;
}

export function verifyLegacyImportApplicationResult(
  application: LegacyImportApplicationEvidence,
): LegacyImportBaseSnapshot {
  const snapshot = verifyLegacyImportApplicationTargets(application);
  if (snapshot.authority.revision !== application.resultingProjectRevision
    || snapshot.authority.authority_epoch !== application.resultingAuthorityEpoch
    || snapshot.relevant_rows_hash !== application.applicationRelevantRowsHash) {
    throw new Error("canonical authority advanced after the retained Import Application");
  }
  return snapshot;
}
