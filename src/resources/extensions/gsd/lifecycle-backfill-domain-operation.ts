// Project/App: gsd-pi
// File Purpose: One explicit lifecycle.backfill Domain Operation that adopts every unadopted hierarchy row.

import { realpathSync } from "node:fs";

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationEventInput,
} from "./db/domain-operation.js";
import { getDb, getDbPath } from "./db/engine.js";
import { isFailedVerificationResult } from "./db/queries.js";
import {
  adoptOrTransitionLifecycle,
  grantLegacyAttestedCancellationWaiver,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "./db/writers/lifecycle-commands.js";
import { projectCanonicalStatusToLegacy } from "./db/writers/status.js";
import { resolveGsdPathContract } from "./paths.js";
import { MILESTONE_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import { normalizeLegacyLifecycleStatus } from "./status-guards.js";

/** The operation type closeout and reopen accept as legacy-attested cancellation authority. */
const LIFECYCLE_BACKFILL_OPERATION_TYPE = "lifecycle.backfill";
const LIFECYCLE_BACKFILLED_EVENT_TYPE = "lifecycle.backfilled";

export type LifecycleBackfillRule =
  | "legacy-open"
  | "legacy-paused"
  | "legacy-blocker-accepted"
  | "legacy-cancelled"
  | "cancelled-with-parent"
  | "cancelled-under-completed-parent"
  | "legacy-complete-evidenced"
  | "legacy-complete-unproven"
  | "legacy-complete-under-completed-parent";

export interface LifecycleBackfillItem {
  itemKind: "milestone" | "slice" | "task";
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
  rawStatus: string;
  completedAt: string | null;
  lifecycleStatus: CanonicalLifecycleStatus;
  rule: LifecycleBackfillRule;
  /** Legacy status written back so legacy and canonical heads agree; null when the raw value already agrees. */
  projectedLegacyStatus: string | null;
}

export interface LifecycleBackfillPreview {
  items: LifecycleBackfillItem[];
  /** Rows whose raw status is not in the one legacy map. The operation refuses while any exist. */
  unknownStatuses: Array<{ row: string; rawStatus: string }>;
  /**
   * Rows that are open work under a Milestone or Slice that is already
   * adopted as completed. They adopt as cancelled and the report lists them.
   */
  openUnderCompletedParent: Array<{ row: string; rawStatus: string }>;
  /**
   * Lifecycle rows that an earlier adoption (for example an Import
   * Application of an earlier build) left as cancelled with no active Waiver.
   * Each gets the one legacy-attested Waiver that closeout requires.
   */
  waiverRepairs: LifecycleWaiverRepair[];
}

export interface LifecycleWaiverRepair {
  itemKind: LifecycleBackfillItem["itemKind"];
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
  rawStatus: string;
  completedAt: string | null;
  lifecycleId: string;
}

export interface LifecycleBackfillResult {
  operationId: string;
  adopted: number;
  waivers: number;
  /**
   * Legacy completions without evidence: adopted as open work, or as
   * completed (unverified legacy) under a completed parent.
   */
  findings: string[];
  /** Open rows under a completed parent, adopted as cancelled. */
  cancelledUnderCompletedParent: string[];
}

export class LifecycleBackfillRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleBackfillRefusedError";
  }
}

interface HierarchyRow {
  itemKind: LifecycleBackfillItem["itemKind"];
  milestoneId: string;
  sliceId: string | null;
  taskId: string | null;
  status: string;
  completedAt: string | null;
  summary: string;
  verification: string;
  lifecycleStatus: string | null;
  lifecycleId: string | null;
  /** Adopted as cancelled (state_version 0) with no active Waiver. */
  cancelledWithoutWaiver: boolean;
}

const TERMINAL = new Set(["completed", "cancelled", "blocker-accepted"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function loadHierarchy(): HierarchyRow[] {
  const lifecycleJoin = (kind: string, row: string, slice: string, task: string) => `
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = '${kind}'
     AND lifecycle.milestone_id = ${row}
     AND lifecycle.slice_id IS ${slice}
     AND lifecycle.task_id IS ${task}`;
  const lifecycleColumns = `lifecycle.lifecycle_status, lifecycle.lifecycle_id,
           (lifecycle.lifecycle_status = 'cancelled' AND lifecycle.state_version = 0 AND NOT EXISTS (
             SELECT 1 FROM workflow_waivers waiver
             WHERE waiver.lifecycle_id = lifecycle.lifecycle_id AND waiver.waiver_status = 'active'
           )) AS cancelled_without_waiver`;
  const rows = getDb().prepare(`
    SELECT 'milestone' AS item_kind, milestone.id AS milestone_id, NULL AS slice_id, NULL AS task_id,
           milestone.status, milestone.completed_at, '' AS summary, '' AS verification,
           ${lifecycleColumns}
    FROM milestones milestone ${lifecycleJoin("milestone", "milestone.id", "NULL", "NULL")}
    UNION ALL
    SELECT 'slice', slice.milestone_id, slice.id, NULL,
           slice.status, slice.completed_at, slice.full_summary_md, '',
           ${lifecycleColumns}
    FROM slices slice ${lifecycleJoin("slice", "slice.milestone_id", "slice.id", "NULL")}
    UNION ALL
    SELECT 'task', task.milestone_id, task.slice_id, task.id,
           task.status, task.completed_at, task.full_summary_md, task.verification_result,
           ${lifecycleColumns}
    FROM tasks task ${lifecycleJoin("task", "task.milestone_id", "task.slice_id", "task.id")}
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    itemKind: row["item_kind"] as HierarchyRow["itemKind"],
    milestoneId: String(row["milestone_id"]),
    sliceId: row["slice_id"] === null ? null : String(row["slice_id"]),
    taskId: row["task_id"] === null ? null : String(row["task_id"]),
    status: String(row["status"]),
    completedAt: text(row["completed_at"]) || null,
    summary: text(row["summary"]),
    verification: text(row["verification"]),
    lifecycleStatus: row["lifecycle_status"] === null ? null : String(row["lifecycle_status"]),
    lifecycleId: row["lifecycle_id"] === null ? null : String(row["lifecycle_id"]),
    cancelledWithoutWaiver: Number(row["cancelled_without_waiver"]) === 1,
  }));
}

function rowLabel(row: Pick<HierarchyRow, "itemKind" | "milestoneId" | "sliceId" | "taskId">): string {
  return [row.milestoneId, row.sliceId, row.taskId].filter(Boolean).join("/");
}

function sliceKey(milestoneId: string, sliceId: string): string {
  return `${milestoneId}/${sliceId}`;
}

/**
 * Classify every unadopted hierarchy row with the one legacy map
 * (status-guards.ts) and the owner's completion rule: a legacy completion is
 * adopted as completed only with completed_at, a summary and a verification
 * that is not 'failed' (Tasks), or a summary and terminal Tasks (Slices), or
 * terminal Slices (Milestones). Other legacy completions adopt as open work.
 * Skipped, deferred and cancelled rows adopt as cancelled; open work under a
 * cancelled parent is cancelled with it. A row that would be open work under
 * a parent already adopted as completed is adopted as cancelled and listed;
 * a legacy completion without evidence under such a parent stays completed
 * as unverified legacy, with a finding (owner decisions 2026-10-03). A
 * lifecycle row already adopted as cancelled with no active Waiver is listed
 * for its one legacy-attested Waiver.
 * Pure read: writes nothing.
 */
export function previewLifecycleBackfill(): LifecycleBackfillPreview {
  const rows = loadHierarchy();
  const unknownStatuses: LifecycleBackfillPreview["unknownStatuses"] = [];
  const normalized = new Map<HierarchyRow, CanonicalLifecycleStatus | null>();
  for (const row of rows) {
    const status = normalizeLegacyLifecycleStatus(row.status);
    normalized.set(row, status);
    if (row.lifecycleStatus === null && status === null) {
      unknownStatuses.push({ row: `${row.itemKind} ${rowLabel(row)}`, rawStatus: row.status });
    }
  }

  // A parent is cancelled when its lifecycle says so, or (unadopted) its raw status maps to cancelled.
  const isCancelled = (row: HierarchyRow) => (row.lifecycleStatus ?? normalized.get(row)) === "cancelled";
  const cancelledMilestones = new Set(
    rows.filter((row) => row.itemKind === "milestone" && isCancelled(row)).map((row) => row.milestoneId),
  );
  const cancelledSlices = new Set(
    rows.filter((row) => row.itemKind === "slice" && (isCancelled(row) || cancelledMilestones.has(row.milestoneId)))
      .map((row) => sliceKey(row.milestoneId, row.sliceId!)),
  );

  const adoptedCompleted = new Set(rows.filter((row) => row.lifecycleStatus === "completed").map(rowLabel));
  const openUnderCompletedParent: LifecycleBackfillPreview["openUnderCompletedParent"] = [];

  const resolved = new Map<HierarchyRow, string>();
  const items: LifecycleBackfillItem[] = [];
  const classify = (
    row: HierarchyRow,
    completionProven: boolean,
    openStatus: "ready" | "pending",
    parentCancelled: boolean,
  ): void => {
    if (row.lifecycleStatus !== null) {
      resolved.set(row, row.lifecycleStatus);
      return;
    }
    const status = normalized.get(row);
    if (status === null || status === undefined) return;
    let lifecycleStatus: CanonicalLifecycleStatus;
    let rule: LifecycleBackfillRule;
    let projectedLegacyStatus: string | null = null;
    const underCompletedParent = adoptedCompleted.has(row.milestoneId) ||
      (row.taskId !== null && adoptedCompleted.has(sliceKey(row.milestoneId, row.sliceId!)));
    if (status === "completed") {
      if (completionProven) {
        lifecycleStatus = "completed";
        rule = "legacy-complete-evidenced";
      } else if (underCompletedParent) {
        lifecycleStatus = "completed";
        rule = "legacy-complete-under-completed-parent";
      } else {
        lifecycleStatus = openStatus;
        rule = "legacy-complete-unproven";
        projectedLegacyStatus = row.itemKind === "milestone" ? "active" : "pending";
      }
    } else if (status === "cancelled") {
      lifecycleStatus = "cancelled";
      rule = "legacy-cancelled";
    } else if (status === "paused") {
      lifecycleStatus = "paused";
      rule = "legacy-paused";
    } else if (status === "blocker-accepted") {
      lifecycleStatus = "blocker-accepted";
      rule = "legacy-blocker-accepted";
    } else {
      // Adoption never yields in_progress: no Attempt stands behind it. An
      // in-flight row adopts as ready; canonical pending agrees only with
      // legacy pending.
      lifecycleStatus = status === "pending" ? openStatus : "ready";
      rule = "legacy-open";
    }
    if (parentCancelled && !TERMINAL.has(lifecycleStatus)) {
      lifecycleStatus = "cancelled";
      rule = "cancelled-with-parent";
      projectedLegacyStatus = "skipped";
    }
    if (!TERMINAL.has(lifecycleStatus) && underCompletedParent) {
      openUnderCompletedParent.push({ row: `${row.itemKind} ${rowLabel(row)}`, rawStatus: row.status });
      lifecycleStatus = "cancelled";
      rule = "cancelled-under-completed-parent";
      projectedLegacyStatus = "skipped";
    }
    resolved.set(row, lifecycleStatus);
    items.push({
      itemKind: row.itemKind,
      milestoneId: row.milestoneId,
      sliceId: row.sliceId,
      taskId: row.taskId,
      rawStatus: row.status,
      completedAt: row.completedAt,
      lifecycleStatus,
      rule,
      projectedLegacyStatus,
    });
  };

  const tasksBySlice = new Map<string, HierarchyRow[]>();
  const slicesByMilestone = new Map<string, HierarchyRow[]>();
  for (const row of rows) {
    if (row.itemKind === "task") {
      const key = sliceKey(row.milestoneId, row.sliceId!);
      tasksBySlice.set(key, [...(tasksBySlice.get(key) ?? []), row]);
    } else if (row.itemKind === "slice") {
      slicesByMilestone.set(row.milestoneId, [...(slicesByMilestone.get(row.milestoneId) ?? []), row]);
    }
  }
  const allTerminal = (children: HierarchyRow[]) =>
    children.every((child) => TERMINAL.has(resolved.get(child) ?? ""));

  for (const row of rows) {
    if (row.itemKind !== "task") continue;
    const proven = row.completedAt !== null && row.summary.length > 0 &&
      row.verification.length > 0 && !isFailedVerificationResult(row.verification);
    classify(row, proven, "ready", cancelledSlices.has(sliceKey(row.milestoneId, row.sliceId!)));
  }
  for (const row of rows) {
    if (row.itemKind !== "slice") continue;
    const tasks = tasksBySlice.get(sliceKey(row.milestoneId, row.sliceId!)) ?? [];
    const proven = row.completedAt !== null && row.summary.length > 0 && allTerminal(tasks);
    classify(row, proven, tasks.length > 0 ? "ready" : "pending", cancelledMilestones.has(row.milestoneId));
  }
  for (const row of rows) {
    if (row.itemKind !== "milestone") continue;
    const slices = slicesByMilestone.get(row.milestoneId) ?? [];
    const proven = row.completedAt !== null && slices.length > 0 && allTerminal(slices);
    classify(row, proven, "ready", false);
  }
  const waiverRepairs = rows.filter((row) => row.cancelledWithoutWaiver).map((row) => ({
    itemKind: row.itemKind,
    milestoneId: row.milestoneId,
    sliceId: row.sliceId,
    taskId: row.taskId,
    rawStatus: row.status,
    completedAt: row.completedAt,
    lifecycleId: row.lifecycleId!,
  }));
  return { items, unknownStatuses, openUnderCompletedParent, waiverRepairs };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * lifecycle_id is random, so a worktree-local database adopted on its own
 * would diverge from the project database on reconcile. Only the
 * project-root database may be backfilled.
 */
function requireProjectRootDatabase(basePath: string): void {
  const openPath = getDbPath();
  const projectDb = resolveGsdPathContract(basePath).projectDb;
  if (!openPath || canonicalPath(openPath) !== canonicalPath(projectDb)) {
    throw new LifecycleBackfillRefusedError(
      `lifecycle backfill refused: the open database (${openPath ?? "none"}) is not the project-root database ${projectDb}`,
    );
  }
}

function projectLegacy(
  context: Parameters<typeof projectCanonicalStatusToLegacy>[0],
  item: LifecycleBackfillItem,
  status: string,
): void {
  if (item.itemKind === "task") {
    projectCanonicalStatusToLegacy(context, {
      entity: "task", milestoneId: item.milestoneId, sliceId: item.sliceId!, taskId: item.taskId!, status,
    });
  } else if (item.itemKind === "slice") {
    projectCanonicalStatusToLegacy(context, {
      entity: "slice", milestoneId: item.milestoneId, sliceId: item.sliceId!, status,
    });
  } else {
    projectCanonicalStatusToLegacy(context, { entity: "milestone", milestoneId: item.milestoneId, status });
  }
}

/**
 * Adopt every hierarchy row that has no lifecycle row, in one Domain
 * Operation: one lifecycle row (state_version 0) and one event per item that
 * keeps the raw legacy status, completed_at and the rule used, plus one
 * legacy-attested Waiver per cancelled item. A lifecycle row already adopted
 * as cancelled with no active Waiver gets its Waiver and one event too.
 * Refuses on a worktree-local database, on any unknown raw status, and when
 * there is nothing to adopt and no Waiver to grant. With
 * GSD_AUTHORITY_CUTOVER=1, the first open of a pre-cutover project database
 * runs it when it would change no legacy status
 * (authority-cutover-on-open.ts); `/gsd db adopt --apply` runs it by hand.
 */
export function applyLifecycleBackfill(basePath: string): LifecycleBackfillResult {
  requireProjectRootDatabase(basePath);
  const preview = previewLifecycleBackfill();
  if (preview.unknownStatuses.length > 0) {
    throw new LifecycleBackfillRefusedError(
      `lifecycle backfill refused: unknown legacy statuses: ${
        preview.unknownStatuses.map((entry) => `${entry.row}=${JSON.stringify(entry.rawStatus)}`).join(", ")
      }`,
    );
  }
  if (preview.items.length === 0 && preview.waiverRepairs.length === 0) {
    throw new LifecycleBackfillRefusedError(
      "lifecycle backfill refused: every hierarchy row already has a lifecycle and every adopted cancellation has a Waiver",
    );
  }

  const fence = readDomainOperationFence();
  const milestoneIds = [
    ...new Set([...preview.items, ...preview.waiverRepairs].map((item) => item.milestoneId)),
  ].sort();
  const report: AdoptionReport = { waivers: 0, findings: [], cancelledUnderCompletedParent: [] };
  const operation = executeDomainOperation({
    operationType: LIFECYCLE_BACKFILL_OPERATION_TYPE,
    idempotencyKey: `command/lifecycle-backfill/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "operator",
    sourceTransport: "internal",
    payload: { itemCount: preview.items.length, waiverRepairCount: preview.waiverRepairs.length },
  }, (context) => {
    const events: DomainOperationEventInput[] = preview.items.map((item) => adoptItem(context, item, report));
    for (const repair of preview.waiverRepairs) {
      const rule = "adopted-cancelled-without-waiver";
      const waiverId = grantLegacyAttestedCancellationWaiver(context, {
        lifecycleId: repair.lifecycleId,
        itemKind: repair.itemKind,
        milestoneId: repair.milestoneId,
        sliceId: repair.sliceId,
        taskId: repair.taskId,
        rationale: `Legacy-attested cancellation adopted before lifecycle backfill ` +
          `(raw status ${JSON.stringify(repair.rawStatus)}, rule ${rule})`,
        grantedByActorId: "lifecycle-backfill",
      });
      report.waivers++;
      events.push({
        eventType: LIFECYCLE_BACKFILLED_EVENT_TYPE,
        entityType: repair.itemKind,
        entityId: rowLabel(repair),
        payload: {
          lifecycleId: repair.lifecycleId,
          rawStatus: repair.rawStatus,
          completedAt: repair.completedAt,
          lifecycleStatus: "cancelled",
          rule,
          evidence: null,
          projectedLegacyStatus: null,
          waiverId,
          finding: null,
        },
        destinations: ["db"],
      });
    }
    return {
      events,
      projections: milestoneIds.map((milestoneId) => ({
        projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
        projectionKind: MILESTONE_LIFECYCLE_PROJECTION_KIND,
        rendererVersion: "1",
      })),
    };
  });
  return {
    operationId: operation.operationId,
    adopted: preview.items.length,
    ...report,
  };
}

type AdoptionReport = Pick<LifecycleBackfillResult, "waivers" | "findings" | "cancelledUnderCompletedParent">;

/** Adopt one classified item inside the Domain Operation of the caller. Returns its event. */
function adoptItem(
  context: Parameters<typeof adoptOrTransitionLifecycle>[0],
  item: LifecycleBackfillItem,
  report: AdoptionReport,
): DomainOperationEventInput {
    const identity = item.itemKind === "task"
      ? { itemKind: "task" as const, milestoneId: item.milestoneId, sliceId: item.sliceId!, taskId: item.taskId! }
      : item.itemKind === "slice"
        ? { itemKind: "slice" as const, milestoneId: item.milestoneId, sliceId: item.sliceId! }
        : { itemKind: "milestone" as const, milestoneId: item.milestoneId };
    const lifecycle = adoptOrTransitionLifecycle(context, { ...identity, lifecycleStatus: item.lifecycleStatus });
    if (item.projectedLegacyStatus !== null) projectLegacy(context, item, item.projectedLegacyStatus);
    let waiverId: string | null = null;
    if (item.lifecycleStatus === "cancelled") {
      waiverId = grantLegacyAttestedCancellationWaiver(context, {
        lifecycleId: lifecycle.lifecycleId,
        itemKind: item.itemKind,
        milestoneId: item.milestoneId,
        sliceId: item.sliceId,
        taskId: item.taskId,
        rationale: `Legacy-attested cancellation adopted by lifecycle backfill ` +
          `(raw status ${JSON.stringify(item.rawStatus)}, rule ${item.rule})`,
        grantedByActorId: "lifecycle-backfill",
      });
      report.waivers++;
    }
    let finding: string | null = null;
    if (item.rule === "legacy-complete-unproven") {
      finding = `${item.itemKind} ${rowLabel(item)} was legacy ${JSON.stringify(item.rawStatus)} ` +
        `without completion evidence; adopted as ${item.lifecycleStatus}`;
      report.findings.push(finding);
    } else if (item.rule === "legacy-complete-under-completed-parent") {
      finding = `${item.itemKind} ${rowLabel(item)} was legacy ${JSON.stringify(item.rawStatus)} ` +
        `without completion evidence under a completed parent; adopted as completed (unverified legacy)`;
      report.findings.push(finding);
    } else if (item.rule === "cancelled-under-completed-parent") {
      finding = `${item.itemKind} ${rowLabel(item)} was legacy ${JSON.stringify(item.rawStatus)} ` +
        `under a completed parent; adopted as cancelled`;
      report.cancelledUnderCompletedParent.push(finding);
    }
    const payload: { [key: string]: DomainJsonValue } = {
      lifecycleId: lifecycle.lifecycleId,
      rawStatus: item.rawStatus,
      completedAt: item.completedAt,
      lifecycleStatus: item.lifecycleStatus,
      rule: item.rule,
      evidence: item.rule === "legacy-complete-evidenced" || item.rule === "legacy-complete-under-completed-parent"
        ? "unverified-legacy"
        : null,
      projectedLegacyStatus: item.projectedLegacyStatus,
      waiverId,
      finding,
    };
    return {
      eventType: LIFECYCLE_BACKFILLED_EVENT_TYPE,
      entityType: item.itemKind,
      entityId: rowLabel(item),
      payload,
      destinations: ["db"],
    };
}

/**
 * Run `merge`, which copies legacy rows from another database (a
 * worktree-local gsd.db) into the open one, and adopt every hierarchy row it
 * inserted, in one lifecycle.backfill Domain Operation. The merge and the
 * adoption commit together with one revision bump, so a merged row never
 * exists without its lifecycle row. A row that was in the database before the
 * merge keeps its adoption state. `merge` returns the payload of the
 * `legacy.merged` event. Refuses, and writes nothing, when an inserted row
 * has a raw status that is not in the one legacy map, or when its adoption
 * would change its legacy status: reopen a legacy completion that has no
 * evidence, or cancel open work under a completed or cancelled parent.
 */
export function mergeLegacyRowsWithAdoption(source: string, merge: () => DomainJsonValue): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: LIFECYCLE_BACKFILL_OPERATION_TYPE,
    idempotencyKey: `${source}/lifecycle-backfill/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "system",
    sourceTransport: "internal",
    payload: { source },
  }, (context) => {
    const before = new Set(loadHierarchy().map((row) => `${row.itemKind} ${rowLabel(row)}`));
    const merged = merge();
    const preview = previewLifecycleBackfill();
    const unknown = preview.unknownStatuses.filter((entry) => !before.has(entry.row));
    if (unknown.length > 0) {
      throw new LifecycleBackfillRefusedError(
        `lifecycle backfill refused: unknown legacy statuses: ${
          unknown.map((entry) => `${entry.row}=${JSON.stringify(entry.rawStatus)}`).join(", ")
        }`,
      );
    }
    const inserted = preview.items.filter((item) => !before.has(`${item.itemKind} ${rowLabel(item)}`));
    // The same owner rule as the cutover on open: a status change needs the
    // preview of /gsd db adopt, so the merge never makes one.
    const statusChanges = inserted.filter((item) => item.projectedLegacyStatus !== null);
    if (statusChanges.length > 0) {
      throw new LifecycleBackfillRefusedError(
        `lifecycle backfill refused: adoption would change the legacy status of ${statusChanges.length} merged row(s): ${
          statusChanges.map((item) =>
            `${item.itemKind} ${rowLabel(item)} ${JSON.stringify(item.rawStatus)} -> ` +
            `${JSON.stringify(item.projectedLegacyStatus)} (${item.rule})`
          ).join(", ")
        }. Nothing was merged. A status change needs the /gsd db adopt preview`,
      );
    }
    const report: AdoptionReport = { waivers: 0, findings: [], cancelledUnderCompletedParent: [] };
    return {
      events: [
        { eventType: "legacy.merged", entityType: "project", entityId: source, payload: merged, destinations: ["db"] },
        ...inserted.map((item) => adoptItem(context, item, report)),
      ],
      projections: [
        { projectionKey: "state", projectionKind: "state", rendererVersion: "1" },
        ...[...new Set(inserted.map((item) => item.milestoneId))].sort().map((milestoneId) => ({
          projectionKey: `lifecycle/${milestoneId}`.toLowerCase(),
          projectionKind: MILESTONE_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        })),
      ],
    };
  });
}

/** Number of milestone, slice and task rows with no lifecycle row (doctor). */
export function countUnadoptedHierarchyRows(): number {
  return loadHierarchy().filter((row) => row.lifecycleStatus === null).length;
}
