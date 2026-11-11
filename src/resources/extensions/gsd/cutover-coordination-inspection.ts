// Bounded observation of the authority cutover guard. No admission or maintenance decisions.
import { createHmac } from "node:crypto";
import type { DbAdapter } from "./db-adapter.js";

export type PidObservation = "self" | "present" | "absent-at-probe" | "permission-denied" | "unknown";
export interface CoordinationObservations {
  now: string;
  localHost: string;
  selfPid: number;
  aliasScope: string;
  observePid: (pid: number) => PidObservation;
  pidObservationTime: () => string;
}

// Keep these identical to requireCoordinationIdle, not generic liveness predicates.
const categories = {
  activeWorkers: { table: "workers", key: "worker_id", columns: "worker_id", predicate: "status = 'active' AND project_root_realpath = (SELECT project_root_realpath FROM project_authority WHERE singleton = 1)" },
  heldLeases: { table: "milestone_leases", key: "milestone_id", columns: "milestone_id, worker_id, acquired_at, expires_at", predicate: "status = 'held'" },
  activeDispatches: { table: "unit_dispatches", key: "id", columns: "id, worker_id, status", predicate: "status IN ('claimed', 'running')" },
  activeAttempts: { table: "workflow_execution_attempts", key: "attempt_id", columns: "attempt_id, worker_id, attempt_state", predicate: "attempt_state IN ('claimed', 'running')" },
} as const;

function timestamp(value: unknown): string | null {
  // Native prepare fences compare the stored strings exactly. Validate, but do not
  // normalize away fractional precision or offsets needed for a factual witness.
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value : null;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("incompatible_count");
  return value;
}

export function inspectCutoverCoordination(db: DbAdapter, root: string, limit: number, observations: CoordinationObservations) {
  if (db.prepare("PRAGMA query_only").get()?.query_only !== 1) throw new Error("query_only_required");
  const authority = db.prepare("SELECT project_id, project_root_realpath, revision, authority_epoch FROM project_authority WHERE singleton = 1").get();
  if (!authority || typeof authority.project_id !== "string" || !authority.project_id.trim()
    || authority.project_root_realpath !== root) throw new Error("checkout_unbound");
  const revision = integer(authority.revision);
  const authorityEpoch = integer(authority.authority_epoch);
  const observedAt = timestamp(observations.now);
  if (!observedAt || !observations.aliasScope || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error("invalid_observations");
  const alias = (kind: string, value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return null;
    return `${kind}-${createHmac("sha256", observations.aliasScope).update(JSON.stringify([kind, value])).digest("hex").slice(0, 16)}`;
  };
  const workers = new Map<unknown, ReturnType<typeof readWorker>>();
  const probes = new Map<number, { state: PidObservation; observedAt: string | null }>();
  function readWorker(id: unknown) {
    const row = db.prepare(`SELECT host, pid, status, started_at, last_heartbeat_at,
      project_root_realpath = ? AS bound_root FROM workers WHERE worker_id = ?`).get(root, id);
    const pid = typeof row?.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 2147483647 ? row.pid : null;
    const relation = typeof row?.host !== "string" || !row.host ? "unknown" : row.host === observations.localHost ? "local" : "remote";
    let probe: { state: PidObservation; observedAt: string | null } = { state: "unknown", observedAt: null };
    if (relation === "local" && pid !== null) {
      if (!probes.has(pid)) {
        let state: PidObservation = "unknown";
        let time: string | null = null;
        try {
          state = pid === observations.selfPid ? "self" : observations.observePid(pid);
          if (!["self", "present", "absent-at-probe", "permission-denied", "unknown"].includes(state)) state = "unknown";
        } catch { state = "unknown"; }
        try { time = timestamp(observations.pidObservationTime()); } catch { /* No probe without a timestamp. */ }
        if (time === null) state = "unknown";
        probes.set(pid, { state, observedAt: time });
      }
      probe = probes.get(pid)!;
    }
    return {
      worker: alias("worker", id), found: !!row,
      status: typeof row?.status === "string" && ["active", "stopping", "stopped", "crashed"].includes(row.status) ? row!.status : "unknown",
      boundRoot: row ? row.bound_root === 1 : null,
      hostRelation: relation, pid, pidObservation: probe,
      startedAt: timestamp(row?.started_at),
      lastHeartbeatAt: timestamp(row?.last_heartbeat_at),
    };
  }
  function worker(id: unknown) {
    if (!workers.has(id)) workers.set(id, readWorker(id));
    return workers.get(id)!;
  }
  const counts = {} as Record<keyof typeof categories, number>;
  const samples: Record<string, { total: number; returned: number; omitted: number; truncated: boolean; rows: unknown[] }> = {};
  for (const category of Object.keys(categories) as (keyof typeof categories)[]) {
    const { table, key, columns, predicate } = categories[category];
    const total = integer(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get()?.count);
    const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${predicate} ORDER BY ${key} LIMIT ?`).all(limit).map((row) => {
      if (category === "activeWorkers") return worker(row.worker_id);
      if (category === "heldLeases") {
        const expiresAt = timestamp(row.expires_at);
        return { lease: alias("lease", row.milestone_id), owner: worker(row.worker_id), acquiredAt: timestamp(row.acquired_at), expiresAt,
          expiry: expiresAt === null ? "unknown" : Date.parse(expiresAt) <= Date.parse(observedAt) ? "expired" : "unexpired" };
      }
      return { item: alias(category === "activeDispatches" ? "dispatch" : "attempt", row[key]),
        status: category === "activeDispatches" ? row.status : row.attempt_state, owner: worker(row.worker_id) };
    });
    counts[category] = total;
    samples[category] = { total, returned: rows.length, omitted: total - rows.length, truncated: total > rows.length, rows };
  }
  // Native maintenance has stricter release checks than the cutover guard. Keep
  // those observations separate; none of these counts grants repair authority.
  const selectedOwner = counts.heldLeases === 1
    ? db.prepare("SELECT worker_id FROM milestone_leases WHERE status = 'held'").get()?.worker_id : null;
  const hasSelectedOwner = typeof selectedOwner === "string" && selectedOwner.length > 0;
  const otherPredicate = hasSelectedOwner ? "worker_id != ? AND status != 'stopped'" : "status != 'stopped'";
  const otherArgs = hasSelectedOwner ? [selectedOwner] : [];
  const otherTotal = integer(db.prepare(`SELECT COUNT(*) AS count FROM workers WHERE ${otherPredicate}`).get(...otherArgs)?.count);
  const staticUnprovable = "(status NOT IN ('stopping', 'crashed') OR host IS NOT ? OR project_root_realpath IS NOT ?)";
  const staticUnprovableCount = integer(db.prepare(`SELECT COUNT(*) AS count FROM workers WHERE ${otherPredicate} AND ${staticUnprovable}`)
    .get(...otherArgs, observations.localHost, root)?.count);
  // Surface statically blocked owners first without claiming that unsampled local
  // PIDs were observed. The exact aggregate excludes no remote/root/status cases.
  const otherRows = db.prepare(`SELECT worker_id FROM workers WHERE ${otherPredicate} ORDER BY ${staticUnprovable} DESC, worker_id LIMIT ?`)
    .all(...otherArgs, observations.localHost, root, limit).map((row) => worker(row.worker_id));
  const nativeMaintenanceObservations = {
    targetOwnerSelection: hasSelectedOwner ? "one-held-lease" : "not-selected",
    otherNonStoppedWorkers: { total: otherTotal, staticUnprovableCount, returned: otherRows.length, omitted: otherTotal - otherRows.length, truncated: otherTotal > otherRows.length, rows: otherRows },
    pendingDispatchCount: integer(db.prepare("SELECT COUNT(*) AS count FROM unit_dispatches WHERE status = 'pending'").get()?.count),
    caveat: "Additional native release predicates only; not eligibility, hardware identity or repair permission.",
  };
  return {
    operation: "authority_cutover_coordination" as const, observedAt, revision, authorityEpoch,
    guardBlocked: Object.values(counts).some((count) => count > 0), counts, samples, nativeMaintenanceObservations,
    caveat: "Snapshot only; not maintenance eligibility or permission. PID presence, absence, reuse and remote hosts never establish original-owner identity or death. Expired held leases still block cutover.",
  };
}
