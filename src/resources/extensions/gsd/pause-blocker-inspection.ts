// Project/App: gsd-pi
// File Purpose: Existing-file, read-only auto-pause inspection and shared association policy.

import { realpathSync, statSync } from "node:fs";
import { inspectSqliteReadOnlySnapshot } from "./sqlite-readonly.js";
import type { PausedSessionMetadata } from "./interrupted-session.js";
import type { AutoPauseBlockerKind, HumanBlockerKind } from "./recovery-policy.js";

/** Deliberately no engine, bootstrap, workspace opener, exec or write methods. */
export interface PauseBlockerReader {
  prepare(sql: string): {
    get(params?: Record<string, string | number | null>): Record<string, unknown> | undefined;
    all(params?: Record<string, string | number | null>): Record<string, unknown>[];
  };
}

const HUMAN_BLOCKER_KINDS = new Set<HumanBlockerKind>([
  "missing_authority", "missing_access", "external_dependency", "consent",
  "ambiguous_intent", "subjective_uat", "user_limit",
]);
export function isHumanPauseBlockerKind(kind: AutoPauseBlockerKind): boolean {
  return HUMAN_BLOCKER_KINDS.has(kind as HumanBlockerKind);
}

const TASK_PAUSE_UNIT_TYPES = new Set(["execute-task", "replan-task"]);
const SLICE_PAUSE_UNIT_TYPES = new Set([
  "complete-slice", "discuss-slice", "plan-slice", "research-slice", "refine-slice", "replan-slice",
  "run-uat", "reassess-roadmap", "rewrite-docs",
]);
const MILESTONE_PAUSE_UNIT_TYPES = new Set([
  "complete-milestone", "research-milestone", "plan-milestone", "discuss-milestone",
  "validate-milestone", "rewrite-docs",
]);
// Persisted ID grammar from milestone-ids.ts, without loading its stateful helpers.
const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;
const SLICE_ID_RE = /^S\d{2,3}$/;
const TASK_ID_RE = /^T\d{2,3}$/;

/** Exact lifecycle only; no parent fallback, association backfill or global DB lookup. */
export function findPauseLifecycleIdIn(db: PauseBlockerReader, input: {
  milestoneId?: string | null;
  unitType?: string | null;
  unitId?: string | null;
}): string | null {
  const milestoneId = input.milestoneId ?? "";
  const parts = (input.unitId ?? "").split("/");
  if (!milestoneId || parts.some((part) => part.length === 0)
    || parts[0] !== milestoneId || !MILESTONE_ID_RE.test(parts[0]!)) return null;
  let row: Record<string, unknown> | undefined;
  if (TASK_PAUSE_UNIT_TYPES.has(input.unitType ?? "") && parts.length === 3
    && SLICE_ID_RE.test(parts[1]!)
    && (TASK_ID_RE.test(parts[2]!)
      || (parts[2]!.startsWith(`${parts[1]}-`) && TASK_ID_RE.test(parts[2]!.slice(parts[1]!.length + 1))))) {
    row = db.prepare(`SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND milestone_id = :milestone_id
        AND slice_id = :slice_id AND task_id = :task_id`).get({
      ":milestone_id": milestoneId, ":slice_id": parts[1]!, ":task_id": parts[2]!,
    });
  } else if (SLICE_PAUSE_UNIT_TYPES.has(input.unitType ?? "") && parts.length === 2
    && SLICE_ID_RE.test(parts[1]!)) {
    row = db.prepare(`SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'slice' AND milestone_id = :milestone_id AND slice_id = :slice_id`)
      .get({ ":milestone_id": milestoneId, ":slice_id": parts[1]! });
  } else if (MILESTONE_PAUSE_UNIT_TYPES.has(input.unitType ?? "") && parts.length === 1) {
    row = db.prepare(`SELECT lifecycle_id FROM workflow_item_lifecycles
      WHERE item_kind = 'milestone' AND milestone_id = :milestone_id`).get({ ":milestone_id": milestoneId });
  } else return null;
  return typeof row?.["lifecycle_id"] === "string" ? row["lifecycle_id"] : null;
}

export type ResolveAutoPauseBlockerFailure =
  | "blocker-not-found" | "blocker-not-open" | "no-associated-pause"
  | "association-mismatch" | "unsupported-blocker-kind" | "owner-mismatch";

export interface AutoPauseBlockerResolutionInspection {
  eligible: boolean;
  failure?: ResolveAutoPauseBlockerFailure;
  projectId: string;
  revision: number;
  authorityEpoch: number;
  blocker?: { id: string; kind: string; owner: string; scope: string; origin: string; lifecycleState: string };
  pause?: { id: string; scope: string };
}

/** Safe fields only. The caller supplies an explicit reader and owns its read transaction. */
export function classifyAutoPauseBlockerResolution(
  db: PauseBlockerReader, blockerId: string,
): AutoPauseBlockerResolutionInspection {
  const authority = db.prepare(`SELECT project_id, revision, authority_epoch FROM project_authority WHERE singleton = 1`).get();
  if (typeof authority?.["project_id"] !== "string" || !authority["project_id"]
    || !Number.isSafeInteger(authority["revision"]) || Number(authority["revision"]) < 0
    || !Number.isSafeInteger(authority["authority_epoch"]) || Number(authority["authority_epoch"]) < 0) {
    throw new Error("Existing database has no compatible Project authority; no adoption was attempted.");
  }
  const result: AutoPauseBlockerResolutionInspection = {
    eligible: false, projectId: authority["project_id"],
    revision: Number(authority["revision"]), authorityEpoch: Number(authority["authority_epoch"]),
  };
  const refuse = (failure: ResolveAutoPauseBlockerFailure) => ({ ...result, failure });
  const blocker = db.prepare(`
    SELECT b.project_id, b.lifecycle_id, b.blocker_kind, b.resolution_owner, b.blocker_status,
           l.project_id AS lifecycle_project_id, l.lifecycle_status, l.item_kind, l.milestone_id, l.slice_id, l.task_id
    FROM workflow_blockers b
    LEFT JOIN workflow_item_lifecycles l ON l.lifecycle_id = b.lifecycle_id
    WHERE b.blocker_id = :id
  `).get({ ":id": blockerId });
  if (!blocker || blocker["project_id"] !== result.projectId) return refuse("blocker-not-found");
  if (blocker["lifecycle_project_id"] !== result.projectId) return refuse("association-mismatch");
  result.blocker = {
    id: blockerId, kind: String(blocker["blocker_kind"]), owner: String(blocker["resolution_owner"]),
    scope: [blocker["milestone_id"], blocker["slice_id"], blocker["task_id"]].filter(Boolean).join("/"),
    origin: "auto-pause", lifecycleState: String(blocker["lifecycle_status"]),
  };
  if (blocker["blocker_status"] !== "open") return refuse("blocker-not-open");
  const legacy = db.prepare(`SELECT pause_id, lifecycle_id, milestone_id, unit_type, unit_id, resolved_at
    FROM auto_pause_blocker_links WHERE blocker_id = :id`).get({ ":id": blockerId });
  if (legacy) {
    if (legacy["resolved_at"] !== null) return refuse("blocker-not-open");
    if (legacy["lifecycle_id"] !== blocker["lifecycle_id"]) return refuse("association-mismatch");
    const row = db.prepare(`SELECT value_json FROM runtime_kv
      WHERE scope = 'global' AND scope_id = '' AND key = :key`).get({ ":key": "paused_session" });
    if (!row) return refuse("no-associated-pause");
    let metadata: PausedSessionMetadata;
    try { metadata = JSON.parse(String(row["value_json"])) as PausedSessionMetadata; }
    catch { return refuse("association-mismatch"); }
    if (!metadata || metadata.pauseId !== legacy["pause_id"] || metadata.pauseBlockerId !== blockerId
      || metadata.milestoneId !== legacy["milestone_id"] || metadata.unitType !== legacy["unit_type"]
      || metadata.unitId !== legacy["unit_id"]
      || (metadata.blockerKind !== undefined && metadata.blockerKind !== blocker["blocker_kind"])
      || !HUMAN_BLOCKER_KINDS.has(blocker["blocker_kind"] as HumanBlockerKind)
      || blocker["resolution_owner"] !== "user"
      || findPauseLifecycleIdIn(db, metadata) !== legacy["lifecycle_id"]) return refuse("association-mismatch");
    result.pause = { id: String(legacy["pause_id"]), scope: String(legacy["lifecycle_id"]) };
  } else {
    const pauses = db.prepare(`SELECT id, scope, blocker_kind, milestone_id, unit_type, unit_id
      FROM auto_pauses WHERE blocker_id = :id AND closed_at IS NULL LIMIT 2`).all({ ":id": blockerId });
    if (pauses.length === 0) return refuse("no-associated-pause");
    const pause = pauses[0]!;
    if (pauses.length !== 1) return refuse("association-mismatch");
    if (!isHumanPauseBlockerKind(blocker["blocker_kind"] as AutoPauseBlockerKind)
      || !isHumanPauseBlockerKind(pause["blocker_kind"] as AutoPauseBlockerKind)
      || blocker["resolution_owner"] !== "user") return refuse("unsupported-blocker-kind");
    const lifecycleId = findPauseLifecycleIdIn(db, {
      milestoneId: pause["milestone_id"] as string | undefined,
      unitType: pause["unit_type"] as string | undefined,
      unitId: pause["unit_id"] as string | undefined,
    });
    if (!lifecycleId || lifecycleId !== blocker["lifecycle_id"]
      || blocker["blocker_kind"] !== pause["blocker_kind"]) return refuse("association-mismatch");
    result.pause = { id: String(pause["id"]), scope: String(pause["scope"]) };
  }
  return { ...result, eligible: true };
}

/** Require an existing checkout binding. Reading must never bind or cut over a Project. */
export function requirePauseBlockerCheckout(db: PauseBlockerReader, projectRoot: string): void {
  const authority = db.prepare(`SELECT project_root_realpath FROM project_authority WHERE singleton = 1`).get();
  if (authority?.["project_root_realpath"] !== projectRoot) {
    throw new Error("Existing database is not bound to this checkout. Open the intended Project normally before resolving; no binding or adoption was attempted.");
  }
}

/** Use the existing read-only provider/snapshot seam; never open or bind the engine. */
export function inspectAutoPauseBlockerFile(
  databasePath: string, projectRoot: string, blockerId: string,
): AutoPauseBlockerResolutionInspection {
  const path = realpathSync(databasePath);
  const identity = statSync(path);
  const snapshot = inspectSqliteReadOnlySnapshot(path, (db) => {
    requirePauseBlockerCheckout(db, projectRoot);
    return classifyAutoPauseBlockerResolution(db, blockerId);
  });
  const current = statSync(path);
  if (realpathSync(databasePath) !== path || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("Project database file changed during inspection; inspect again.");
  }
  return snapshot;
}
